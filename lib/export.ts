 import { getDb } from "./db";
import { requireSessionOwner } from "./authz";
import { previousPart1Submissions } from "./reopen-part1";
import { audit, formatTimestamp, invalid, now } from "./util";
import { STAGE_LABELS, type User } from "./types";
import type { RawFile } from "./router";

// A cell starting with = + - @ would be run as a formula by spreadsheet software: neutralise it.
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function parse(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function collectExport(user: User, sessionId: string) {
  const s = requireSessionOwner(user, sessionId);
  const db = getDb();
  const questions = db.prepare("SELECT id, position, text, created_at FROM guiding_questions WHERE session_id = ? ORDER BY position").all(s.id) as Array<{
    id: string;
    position: number;
    text: string;
    created_at: string;
  }>;
  const qText = new Map(questions.map((q) => [q.id, q.text]));
  const groups = db.prepare("SELECT id, code, name, active FROM groups WHERE session_id = ? ORDER BY code").all(s.id) as Array<{
    id: string;
    code: string;
    name: string;
    active: number;
  }>;
  const subs = db
    .prepare(
      `SELECT gs.group_id, gs.part, gs.submitted_at, u.name AS submitted_by, gs.snapshot_json
       FROM group_submissions gs JOIN users u ON u.id = gs.submitted_by WHERE gs.session_id = ? ORDER BY gs.part, gs.submitted_at`,
    )
    .all(s.id) as Array<{ group_id: string; part: number; submitted_at: string; submitted_by: string; snapshot_json: string }>;
  const subKey = new Map(subs.map((x) => [`${x.group_id}:${x.part}`, x]));
  const gById = new Map(groups.map((g) => [g.id, g]));
  const rows = db
    .prepare(
      `SELECT e.*, u.name AS author_name, u.email AS author_email, (sh.entry_id IS NOT NULL) AS shared, sh.show_author
       FROM entries e JOIN users u ON u.id = e.author_id LEFT JOIN entry_shares sh ON sh.entry_id = e.id
       WHERE e.session_id = ? ORDER BY e.group_id, e.part, e.seq`,
    )
    .all(s.id) as Array<Record<string, unknown>>;
  const entries = rows
    .filter((e) => !e.deleted_at || e.observation || e.evidence || e.interpretation || e.question) // skip never-used blank drafts
    .map((e) => {
      const g = gById.get(e.group_id as string);
      const sub = subKey.get(`${e.group_id}:${e.part}`);
      return {
        entry_id: e.public_id,
        internal_id: e.id,
        stage_label: STAGE_LABELS[e.part as number],
        part: e.part,
        group_code: g?.code,
        group_name: g?.name,
        author_name: e.author_name,
        author_email: e.author_email,
        observation: e.observation,
        timestamp: formatTimestamp(e.timestamp_sec as number | null),
        timestamp_sec: e.timestamp_sec,
        evidence: e.evidence,
        interpretation: e.interpretation,
        question: e.question,
        guiding_question_id: e.guiding_question_id,
        guiding_question_text: e.guiding_question_id ? (qText.get(e.guiding_question_id as string) ?? "") : "",
        status: sub ? "submitted" : "draft",
        version: e.version,
        created_at: e.created_at,
        updated_at: e.updated_at,
        submitted_at: sub?.submitted_at ?? "",
        submitted_by: sub?.submitted_by ?? "",
        shared_with_participants: !!e.shared,
        deleted_at: e.deleted_at ?? "",
      };
    });
  const aiRows = db.prepare("SELECT * FROM ai_outputs WHERE session_id = ? ORDER BY created_at").all(s.id) as Array<Record<string, unknown>>;
  const ai = aiRows.map((a) => ({
    id: a.id,
    kind: a.kind,
    group_code: a.group_id ? (gById.get(a.group_id as string)?.code ?? "") : "",
    part: a.part,
    status: a.status,
    simulated: !!a.simulated,
    provider: a.provider,
    model: a.model,
    criteria: a.criteria,
    source_entry_ids: parse(a.source_entry_ids_json),
    warnings: parse(a.warnings_json),
    generated_content: parse(a.generated_json),
    edited_content: parse(a.edited_json),
    published_content: parse(a.published_json),
    created_at: a.created_at,
    reviewed_at: a.reviewed_at ?? "",
    published_at: a.published_at ?? "",
    updated_at: a.updated_at,
  }));
  const overrides = (db.prepare("SELECT * FROM session_overrides WHERE session_id = ? ORDER BY created_at").all(s.id) as Array<Record<string, unknown>>).map((o) => ({
    part: o.part,
    stage_label: STAGE_LABELS[o.part as number],
    reason: o.reason,
    missing_groups: (parse(o.missing_group_ids_json) as string[]).map((id) => gById.get(id)?.code ?? id),
    created_at: o.created_at,
  }));
  return {
    session: s,
    previous_part1_submissions: previousPart1Submissions(s.id),
    questions,
    groups,
    submissions: subs.map((x) => ({
      group_code: gById.get(x.group_id)?.code,
      part: x.part,
      stage_label: STAGE_LABELS[x.part],
      submitted_at: x.submitted_at,
      submitted_by: x.submitted_by,
      snapshot: parse(x.snapshot_json),
    })),
    entries,
    ai,
    overrides,
  };
}

export function exportSession(user: User, sessionId: string, format: string, what: string): RawFile {
  const data = collectExport(user, sessionId);
  const slug = data.session.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  const stamp = now().slice(0, 10);
  audit(data.session.id, user.id, "exported", { format, what });
  if (format === "json") {
    const { join_code: _jc, facilitator_id: _fid, ...sessionOut } = data.session; // eslint-disable-line @typescript-eslint/no-unused-vars
    return {
      __raw: true,
      contentType: "application/json; charset=utf-8",
      filename: `pd-${slug}-${stamp}.json`,
      text: JSON.stringify({ exported_at: now(), format_version: 1, ...data, session: sessionOut }, null, 2),
    };
  }
  if (format === "csv") {
    if (what === "questions") {
      return {
        __raw: true,
        contentType: "text/csv; charset=utf-8",
        filename: `pd-${slug}-guiding-questions-${stamp}.csv`,
        text: toCsv(["position", "id", "text", "created_at"], data.questions),
      };
    }
    if (what === "ai") {
      const rows = data.ai.map((a) => ({
        ...a,
        source_entry_ids: (a.source_entry_ids as string[] | null)?.join(" ") ?? "",
        warnings: (a.warnings as string[] | null)?.join(" | ") ?? "",
        generated_content: JSON.stringify(a.generated_content),
        edited_content: a.edited_content ? JSON.stringify(a.edited_content) : "",
        published_content: a.published_content ? JSON.stringify(a.published_content) : "",
      }));
      return {
        __raw: true,
        contentType: "text/csv; charset=utf-8",
        filename: `pd-${slug}-ai-outputs-${stamp}.csv`,
        text: toCsv(
          ["id", "kind", "group_code", "part", "status", "simulated", "provider", "model", "criteria", "source_entry_ids", "warnings", "generated_content", "edited_content", "published_content", "created_at", "reviewed_at", "published_at"],
          rows,
        ),
      };
    }
    if (what !== "all" && what !== "entries") throw invalid("what must be entries, questions or ai");
    return {
      __raw: true,
      contentType: "text/csv; charset=utf-8",
      filename: `pd-${slug}-responses-${stamp}.csv`,
      text: toCsv(
        ["stage_label", "part", "group_code", "group_name", "entry_id", "author_name", "author_email", "observation", "timestamp", "timestamp_sec", "evidence", "interpretation", "question", "guiding_question_id", "guiding_question_text", "status", "version", "created_at", "updated_at", "submitted_at", "submitted_by", "shared_with_participants", "deleted_at"],
        data.entries,
      ),
    };
  }
  throw invalid("format must be json or csv");
}
