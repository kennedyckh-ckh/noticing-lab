import { getDb } from "./db";
import { requireFacilitator, requireSessionMember, requireSessionOwner } from "./authz";
import { asRecord, audit, conflict, invalid, notFound, now, str, uid, HttpError } from "./util";
import { stageGate } from "./facilitator";
import { assertAiOutputCurrent, submissionScopeToken } from "./reopen-part1";
import { loadSnapshots, type EntrySnap } from "./ai/entries";
import { getProvider, providerInfo } from "./ai/provider";
import { normaliseContent } from "./ai/validate";
import type { AiKind } from "./ai/types";
import type { Group, PdSession, User } from "./types";

type PartScope = "1" | "2" | "both";
const KINDS: AiKind[] = ["group_summary", "cross_group", "salient_points"];
const MAX_ENTRIES = 250;

interface OutputRow {
  id: string;
  session_id: string;
  kind: AiKind;
  group_id: string | null;
  part: PartScope;
  status: "draft" | "published";
  provider: string;
  model: string;
  simulated: number;
  criteria: string;
  generated_json: string;
  edited_json: string | null;
  source_entry_ids_json: string;
  warnings_json: string;
  override_id: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  published_json: string | null;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

const partsOf = (p: PartScope): Array<1 | 2> => (p === "both" ? [1, 2] : p === "1" ? [1] : [2]);

function serialise(o: OutputRow, groups: Map<string, Group>) {
  const g = o.group_id ? groups.get(o.group_id) : undefined;
  return {
    id: o.id,
    kind: o.kind,
    group: g ? { id: g.id, code: g.code, name: g.name } : null,
    part: o.part,
    status: o.status,
    provider: o.provider,
    model: o.model,
    simulated: !!o.simulated,
    criteria: o.criteria,
    generated: JSON.parse(o.generated_json),
    content: JSON.parse(o.edited_json ?? o.generated_json),
    edited: o.edited_json !== null,
    source_entry_ids: JSON.parse(o.source_entry_ids_json) as string[],
    warnings: JSON.parse(o.warnings_json) as string[],
    reviewed_at: o.reviewed_at,
    published_at: o.published_at,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

function ownOutput(user: User, id: string): { o: OutputRow; session: PdSession } {
  requireFacilitator(user);
  const o = getDb().prepare("SELECT * FROM ai_outputs WHERE id = ?").get(id) as OutputRow | undefined;
  if (!o) throw notFound("AI output not found");
  return { o, session: requireSessionOwner(user, o.session_id) };
}

export function listOutputs(user: User, sessionId: string) {
  const s = requireSessionOwner(user, sessionId);
  const db = getDb();
  const groups = new Map((db.prepare("SELECT * FROM groups WHERE session_id = ?").all(s.id) as Group[]).map((g) => [g.id, g]));
  const rows = db.prepare("SELECT * FROM ai_outputs WHERE session_id = ? ORDER BY created_at DESC").all(s.id) as OutputRow[];
  return { provider: providerInfo(), outputs: rows.map((r) => serialise(r, groups)) };
}

function parsePart(v: unknown): PartScope {
  const p = String(v);
  if (p === "1" || p === "2" || p === "both") return p;
  throw invalid("part must be 1, 2 or both");
}

export async function generate(user: User, sessionId: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  const body = asRecord(bodyRaw);
  const kind = KINDS.find((k) => k === body.kind);
  if (!kind) throw invalid("kind must be group_summary, cross_group or salient_points");
  const part = parsePart(body.part);
  const parts = partsOf(part);
  if (parts.includes(2) && !s.part2_unlocked_at) throw conflict("Part 2 has not been unlocked yet", "PART2_LOCKED");
  const db = getDb();

  let entries: EntrySnap[];
  let groupId: string | null = null;
  let overrideId: string | null = null;
  const missingNotes: string[] = [];

  if (kind === "group_summary") {
    if (typeof body.group_id !== "string") throw invalid("group_id is required for a group summary");
    const g = db.prepare("SELECT * FROM groups WHERE id = ? AND session_id = ?").get(body.group_id, s.id) as Group | undefined;
    if (!g) throw notFound("Group not found");
    groupId = g.id;
    for (const p of parts) {
      const sub = db.prepare("SELECT 1 FROM group_submissions WHERE group_id = ? AND part = ?").get(g.id, p);
      if (!sub) throw conflict(`${g.name} has not submitted Part ${p}. The AI only analyses submitted work.`, "NOT_SUBMITTED");
    }
    entries = loadSnapshots(s.id, { parts, groupIds: [g.id] });
  } else {
    // whole-session analysis needs every active group, or a deliberate override on record
    for (const p of parts) {
      const gate = stageGate(s.id, p);
      if (!gate.ok) {
        throw conflict(
          gate.counts.active === 0
            ? "There are no active groups."
            : `${gate.counts.submitted} of ${gate.counts.active} active groups have submitted Part ${p}. Record a deliberate override for the missing groups (${gate.counts.missing.map((m) => m.name).join(", ")}) to continue without them.`,
          "MISSING_SUBMISSIONS",
          { counts: gate.counts, part: p },
        );
      }
      if (gate.override_id) {
        overrideId = gate.override_id;
        missingNotes.push(`Part ${p}: generated with an override. Missing groups: ${gate.counts.missing.map((m) => m.name).join(", ")}.`);
      }
    }
    entries = loadSnapshots(s.id, { parts, activeOnly: true });
  }
  if (entries.length === 0) throw conflict("There are no submitted entries to analyse", "NO_ENTRIES");
  if (entries.length > MAX_ENTRIES) throw conflict(`Too many entries (${entries.length}) for one analysis. Analyse one part at a time.`, "TOO_MANY_ENTRIES");

  const criteria = kind === "salient_points" ? str(body.criteria ?? s.salient_criteria, "Criteria", 2000) : "";
  if (kind === "salient_points" && !criteria) throw invalid("Write the criteria for salient points (or save default criteria in Settings) first");

  const submissionToken = submissionScopeToken(s.id, parts, groupId);
  const result = await getProvider()({ kind, entries, criteria });
  if (submissionToken !== submissionScopeToken(s.id, parts, groupId)) {
    throw conflict("Submitted work changed while the AI was running. The response was discarded. Generate again after resubmission.", "AI_SOURCES_CHANGED");
  }
  const { content, warnings, sourceIds } = normaliseContent(kind, result.raw, entries, missingNotes);
  const allWarnings = result.simulated ? ["Simulated output: no AI model was used.", ...warnings] : warnings;
  const id = uid();
  const t = now();
  db.prepare(
    `INSERT INTO ai_outputs (id, session_id, kind, group_id, part, status, provider, model, simulated, criteria, generated_json,
       source_entry_ids_json, warnings_json, override_id, created_at, created_by, updated_at)
     VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, s.id, kind, groupId, part, result.provider, result.model, result.simulated ? 1 : 0, criteria, JSON.stringify(content), JSON.stringify(sourceIds), JSON.stringify(allWarnings), overrideId, t, user.id, t);
  audit(s.id, user.id, "ai_generated", { id, kind, part, group_id: groupId, provider: result.provider, model: result.model, entries: entries.length, override_id: overrideId });
  return listOutputs(user, s.id).outputs.find((o) => o.id === id);
}

/** A facilitator edit may cite any submitted entry in the scope the draft was generated from, and nothing else. */
function allowedForEdit(o: OutputRow): EntrySnap[] {
  return loadSnapshots(o.session_id, { parts: partsOf(o.part), groupIds: o.group_id ? [o.group_id] : undefined, activeOnly: o.group_id ? false : true });
}

export function editOutput(user: User, id: string, bodyRaw: unknown) {
  const { o } = ownOutput(user, id);
  assertAiOutputCurrent(o.id);
  if (o.status === "published") throw conflict("Unpublish this output before editing it", "PUBLISHED");
  const body = asRecord(bodyRaw);
  if (!body.content || typeof body.content !== "object") throw invalid("content is required");
  const { content, warnings } = normaliseContent(o.kind, body.content, allowedForEdit(o));
  const t = now();
  getDb().prepare("UPDATE ai_outputs SET edited_json = ?, reviewed_at = NULL, reviewed_by = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(content), t, o.id);
  audit(o.session_id, user.id, "ai_edited", { id: o.id });
  return { id: o.id, content, edit_warnings: warnings.filter((w) => !w.startsWith("SIMULATED")), reviewed_at: null };
}

export function markReviewed(user: User, id: string, bodyRaw: unknown) {
  const { o } = ownOutput(user, id);
  assertAiOutputCurrent(o.id);
  if (o.status === "published") throw conflict("This output is already published", "PUBLISHED");
  const on = asRecord(bodyRaw).reviewed !== false;
  const t = now();
  getDb()
    .prepare("UPDATE ai_outputs SET reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?")
    .run(on ? t : null, on ? user.id : null, t, o.id);
  audit(o.session_id, user.id, on ? "ai_reviewed" : "ai_unreviewed", { id: o.id });
  return { id: o.id, reviewed_at: on ? t : null };
}

export function unpublish(user: User, id: string) {
  const { o } = ownOutput(user, id);
  if (o.status !== "published") throw conflict("This output is not published", "NOT_PUBLISHED");
  getDb().prepare("UPDATE ai_outputs SET status = 'draft', published_json = NULL, published_at = NULL, published_by = NULL, updated_at = ? WHERE id = ?").run(now(), o.id);
  audit(o.session_id, user.id, "ai_unpublished", { id: o.id, kind: o.kind });
  return { id: o.id, status: "draft" };
}

export function deleteDraft(user: User, id: string) {
  const { o } = ownOutput(user, id);
  if (o.status === "published") throw conflict("Unpublish this output before deleting it", "PUBLISHED");
  getDb().prepare("DELETE FROM ai_outputs WHERE id = ?").run(o.id);
  audit(o.session_id, user.id, "ai_deleted", { id: o.id, kind: o.kind });
  return { deleted: true };
}

/**
 * The two separate release actions. Group summaries and salient points are published by their
 * own endpoints, each only for its own kind, and only after the facilitator has marked the
 * draft as reviewed. What participants later read is a frozen copy taken at this moment.
 */
export function publishKind(user: User, sessionId: string, kind: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  if (kind !== "group_summary" && kind !== "salient_points") throw invalid("Only group summaries and salient points can be published");
  const body = asRecord(bodyRaw);
  const db = getDb();
  let rows = db.prepare("SELECT * FROM ai_outputs WHERE session_id = ? AND kind = ? AND status = 'draft'").all(s.id, kind) as OutputRow[];
  if (Array.isArray(body.ids)) {
    const wanted = new Set(body.ids.map(String));
    const found = rows.filter((r) => wanted.has(r.id));
    if (found.length !== wanted.size) throw notFound("One of those drafts was not found (it may already be published)");
    const unreviewed = found.filter((r) => !r.reviewed_at);
    if (unreviewed.length) throw conflict("Review each draft before publishing it", "NOT_REVIEWED", { ids: unreviewed.map((r) => r.id) });
    rows = found;
  } else {
    rows = rows.filter((r) => r.reviewed_at);
  }
  if (rows.length === 0) throw conflict("There are no reviewed drafts to publish. Open a draft, check it, edit if needed, and mark it reviewed first.", "NOTHING_TO_PUBLISH");
  for (const row of rows) assertAiOutputCurrent(row.id);
  const t = now();
  db.transaction(() => {
    for (const r of rows) {
      // a newer publication for the same group and part replaces the older one
      db.prepare(
        `UPDATE ai_outputs SET status='draft', published_json=NULL, published_at=NULL, published_by=NULL
         WHERE session_id=? AND kind=? AND part=? AND COALESCE(group_id,'')=COALESCE(?, '') AND status='published' AND id != ?`,
      ).run(s.id, kind, r.part, r.group_id, r.id);
      db.prepare("UPDATE ai_outputs SET status='published', published_json=?, published_at=?, published_by=?, updated_at=? WHERE id=?").run(r.edited_json ?? r.generated_json, t, user.id, t, r.id);
    }
  })();
  audit(s.id, user.id, kind === "group_summary" ? "summaries_published" : "salient_revealed", { ids: rows.map((r) => r.id) });
  return { published: rows.length, ids: rows.map((r) => r.id), kind };
}

/** What participants may see: PUBLISHED group summaries and salient points only. Never drafts, never the cross-group comparison. */
export function publishedView(user: User, sessionId: string) {
  requireSessionMember(user, sessionId);
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.kind, o.part, o.published_json, o.published_at, o.simulated, g.code AS group_code, g.name AS group_name
       FROM ai_outputs o LEFT JOIN groups g ON g.id = o.group_id
       WHERE o.session_id = ? AND o.status = 'published' AND o.published_json IS NOT NULL AND o.kind IN ('group_summary','salient_points')
       ORDER BY o.published_at`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  const shape = (r: Record<string, unknown>) => ({
    id: r.id,
    part: r.part,
    group: r.group_code ? { code: r.group_code, name: r.group_name } : null,
    content: JSON.parse(r.published_json as string),
    published_at: r.published_at,
    simulated: !!r.simulated,
  });
  return {
    published_summaries: rows.filter((r) => r.kind === "group_summary").map(shape),
    published_salient: rows.filter((r) => r.kind === "salient_points").map(shape),
  };
}

export { HttpError };
