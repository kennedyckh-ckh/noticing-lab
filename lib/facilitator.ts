import { getDb } from "./db";
import { createUser, normaliseEmail } from "./auth";
import { requireFacilitator, requireSessionOwner } from "./authz";
import { asRecord, audit, conflict, forbidden, invalid, notFound, now, randomCode, str, tempPassword, uid } from "./util";
import { STAGE_LABELS, type EntryRow, type Group, type PdSession, type User } from "./types";

function cleanUrl(v: unknown): string {
  const s = str(v, "Video link", 500);
  if (s === "") return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw invalid("The video link must be a full web address starting with https://");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw invalid("The video link must start with http:// or https://");
  return u.toString();
}

// ---------- sessions ----------

export function createSession(user: User, bodyRaw: unknown) {
  requireFacilitator(user);
  const body = asRecord(bodyRaw);
  const title = str(body.title, "Title", 200, { required: true });
  const numGroups = body.num_groups === undefined ? 3 : Number(body.num_groups);
  if (!Number.isInteger(numGroups) || numGroups < 1 || numGroups > 12) throw invalid("Number of groups must be between 1 and 12");
  const db = getDb();
  const id = uid();
  const tx = db.transaction(() => {
    let code = randomCode(6);
    while (db.prepare("SELECT 1 FROM pd_sessions WHERE join_code = ?").get(code)) code = randomCode(6);
    db.prepare(
      `INSERT INTO pd_sessions (id, facilitator_id, title, description, video_title, video_url, join_code, salient_criteria, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      user.id,
      title,
      str(body.description, "Description", 2000),
      str(body.video_title, "Video title", 200),
      cleanUrl(body.video_url),
      code,
      str(body.salient_criteria, "Salient point criteria", 2000),
      now(),
    );
    for (let i = 1; i <= numGroups; i++) {
      db.prepare("INSERT INTO groups (id, session_id, code, name, active, created_at) VALUES (?,?,?,?,1,?)").run(
        uid(),
        id,
        `G${i}`,
        `Group ${i}`,
        now(),
      );
    }
    audit(id, user.id, "session_created", { title });
  });
  tx();
  return { id };
}

export function listSessions(user: User) {
  requireFacilitator(user);
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.title, s.description, s.join_code, s.part2_unlocked_at, s.created_at,
         (SELECT COUNT(*) FROM groups g WHERE g.session_id = s.id AND g.active = 1) AS active_groups,
         (SELECT COUNT(*) FROM session_members m WHERE m.session_id = s.id) AS joined
       FROM pd_sessions s WHERE s.facilitator_id = ? ORDER BY s.created_at DESC`,
    )
    .all(user.id);
  return { sessions: rows };
}

export function sessionDetail(user: User, sessionId: string) {
  const s = requireSessionOwner(user, sessionId);
  const db = getDb();
  const groups = db.prepare("SELECT * FROM groups WHERE session_id = ? ORDER BY code").all(s.id) as Group[];
  const authorised = db
    .prepare(
      `SELECT a.group_id, u.id AS user_id, u.name, u.email,
         (SELECT 1 FROM session_members m WHERE m.session_id = ? AND m.user_id = u.id) AS joined,
         (SELECT 1 FROM group_members gm WHERE gm.group_id = a.group_id AND gm.user_id = u.id) AS selected
       FROM group_authorisations a JOIN users u ON u.id = a.user_id
       JOIN groups g ON g.id = a.group_id WHERE g.session_id = ? ORDER BY u.name`,
    )
    .all(s.id, s.id) as Array<{ group_id: string; user_id: string; name: string; email: string; joined: number | null; selected: number | null }>;
  const questions = db.prepare("SELECT id, position, text FROM guiding_questions WHERE session_id = ? ORDER BY position").all(s.id);
  return {
    session: {
      id: s.id,
      title: s.title,
      description: s.description,
      video_title: s.video_title,
      video_url: s.video_url,
      join_code: s.join_code,
      sharing_enabled: !!s.sharing_enabled,
      salient_criteria: s.salient_criteria,
      part2_unlocked_at: s.part2_unlocked_at,
      created_at: s.created_at,
    },
    groups: groups.map((g) => ({
      id: g.id,
      code: g.code,
      name: g.name,
      active: !!g.active,
      people: authorised
        .filter((a) => a.group_id === g.id)
        .map((a) => ({ user_id: a.user_id, name: a.name, email: a.email, joined: !!a.joined, selected: !!a.selected })),
    })),
    guiding_questions: questions,
  };
}

export function updateSession(user: User, sessionId: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  const body = asRecord(bodyRaw);
  const next = {
    title: "title" in body ? str(body.title, "Title", 200, { required: true }) : s.title,
    description: "description" in body ? str(body.description, "Description", 2000) : s.description,
    video_title: "video_title" in body ? str(body.video_title, "Video title", 200) : s.video_title,
    video_url: "video_url" in body ? cleanUrl(body.video_url) : s.video_url,
    salient_criteria: "salient_criteria" in body ? str(body.salient_criteria, "Salient point criteria", 2000) : s.salient_criteria,
    sharing_enabled: "sharing_enabled" in body ? (body.sharing_enabled ? 1 : 0) : s.sharing_enabled,
  };
  getDb()
    .prepare(
      `UPDATE pd_sessions SET title=?, description=?, video_title=?, video_url=?, salient_criteria=?, sharing_enabled=? WHERE id=?`,
    )
    .run(next.title, next.description, next.video_title, next.video_url, next.salient_criteria, next.sharing_enabled, s.id);
  if (next.sharing_enabled !== s.sharing_enabled) audit(s.id, user.id, "sharing_toggled", { enabled: !!next.sharing_enabled });
  return sessionDetail(user, sessionId);
}

// ---------- groups and roster ----------

export function createGroup(user: User, sessionId: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  const db = getDb();
  const rows = db.prepare("SELECT code FROM groups WHERE session_id = ?").all(s.id) as Array<{ code: string }>;
  if (rows.length >= 24) throw conflict("A session can have at most 24 groups", "GROUP_LIMIT");
  const nextNum = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(1)) || 0), 0) + 1;
  const name = str(asRecord(bodyRaw).name, "Group name", 80) || `Group ${nextNum}`;
  const id = uid();
  db.prepare("INSERT INTO groups (id, session_id, code, name, active, created_at) VALUES (?,?,?,?,1,?)").run(id, s.id, `G${nextNum}`, name, now());
  audit(s.id, user.id, "group_created", { group_id: id });
  return { id };
}

function ownGroup(user: User, groupId: string): { group: Group; session: PdSession } {
  requireFacilitator(user);
  const group = getDb().prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as Group | undefined;
  if (!group) throw notFound("Group not found");
  const session = requireSessionOwner(user, group.session_id);
  return { group, session };
}

export function updateGroup(user: User, groupId: string, bodyRaw: unknown) {
  const { group, session } = ownGroup(user, groupId);
  const body = asRecord(bodyRaw);
  const name = "name" in body ? str(body.name, "Group name", 80, { required: true }) : group.name;
  const active = "active" in body ? (body.active ? 1 : 0) : group.active;
  getDb().prepare("UPDATE groups SET name = ?, active = ? WHERE id = ?").run(name, active, group.id);
  if (active !== group.active) audit(session.id, user.id, "group_active_changed", { group_id: group.id, active: !!active });
  return { id: group.id, name, active: !!active };
}

export function createParticipants(user: User, sessionId: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  const body = asRecord(bodyRaw);
  if (!Array.isArray(body.people) || body.people.length === 0 || body.people.length > 100) {
    throw invalid("Provide between 1 and 100 people");
  }
  const db = getDb();
  let groupId: string | null = null;
  if (body.group_id !== undefined && body.group_id !== null && body.group_id !== "") {
    const g = typeof body.group_id === "string" ? (db.prepare("SELECT * FROM groups WHERE id = ? AND session_id = ?").get(body.group_id, s.id) as Group | undefined) : undefined;
    if (!g) throw invalid("That group does not belong to this session");
    groupId = g.id;
  }
  const results: Array<Record<string, unknown>> = [];
  for (const p of body.people) {
    const rec = asRecord(p);
    try {
      const email = normaliseEmail(rec.email);
      const name = str(rec.name, "Name", 120, { required: true });
      const existing = db.prepare("SELECT id, role, name FROM users WHERE email = ?").get(email) as
        | { id: string; role: string; name: string }
        | undefined;
      let userId: string;
      let status: "created" | "existing";
      let temp: string | undefined;
      if (existing) {
        if (existing.role !== "participant") throw invalid("That email belongs to a facilitator account");
        userId = existing.id;
        status = "existing";
      } else {
        temp = tempPassword();
        userId = createUser({ email, name, password: temp, role: "participant", mustChange: true }).id;
        status = "created";
      }
      if (groupId) {
        db.prepare("INSERT OR IGNORE INTO group_authorisations (group_id, user_id, created_at) VALUES (?,?,?)").run(groupId, userId, now());
      }
      results.push({ email, name: existing?.name ?? name, status, user_id: userId, temp_password: temp, authorised: !!groupId });
    } catch (e) {
      results.push({ email: rec.email, status: "error", error: e instanceof Error ? e.message : "Failed" });
    }
  }
  audit(s.id, user.id, "participants_added", { count: results.length, group_id: groupId });
  return { results };
}

export function authoriseUser(user: User, groupId: string, bodyRaw: unknown) {
  const { group, session } = ownGroup(user, groupId);
  const userId = asRecord(bodyRaw).user_id;
  if (typeof userId !== "string") throw invalid("user_id is required");
  const u = getDb().prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!u || u.role !== "participant") throw invalid("That person is not a participant account");
  getDb().prepare("INSERT OR IGNORE INTO group_authorisations (group_id, user_id, created_at) VALUES (?,?,?)").run(group.id, u.id, now());
  audit(session.id, user.id, "group_authorised", { group_id: group.id, user_id: u.id });
  return { authorised: true };
}

/** Removes the allow-list entry AND the person's membership, so access ends immediately. */
export function deauthoriseUser(user: User, groupId: string, targetUserId: string) {
  const { group, session } = ownGroup(user, groupId);
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM group_authorisations WHERE group_id = ? AND user_id = ?").run(group.id, targetUserId);
    db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(group.id, targetUserId);
  })();
  audit(session.id, user.id, "group_deauthorised", { group_id: group.id, user_id: targetUserId });
  return { removed: true };
}

// ---------- guiding questions ----------

export function addQuestion(user: User, sessionId: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  const text = str(asRecord(bodyRaw).text, "Question", 1000, { required: true });
  const db = getDb();
  const pos = (db.prepare("SELECT COALESCE(MAX(position),0)+1 AS p FROM guiding_questions WHERE session_id = ?").get(s.id) as { p: number }).p;
  const id = uid();
  db.prepare("INSERT INTO guiding_questions (id, session_id, position, text, created_at) VALUES (?,?,?,?,?)").run(id, s.id, pos, text, now());
  return { id, position: pos, text };
}

function ownQuestion(user: User, qid: string) {
  requireFacilitator(user);
  const q = getDb().prepare("SELECT * FROM guiding_questions WHERE id = ?").get(qid) as
    | { id: string; session_id: string; position: number; text: string }
    | undefined;
  if (!q) throw notFound("Question not found");
  const session = requireSessionOwner(user, q.session_id);
  return { q, session };
}

export function updateQuestion(user: User, qid: string, bodyRaw: unknown) {
  const { q, session } = ownQuestion(user, qid);
  const text = str(asRecord(bodyRaw).text, "Question", 1000, { required: true });
  getDb().prepare("UPDATE guiding_questions SET text = ? WHERE id = ?").run(text, q.id);
  if (session.part2_unlocked_at) audit(session.id, user.id, "guiding_question_edited_after_unlock", { question_id: q.id });
  return { id: q.id, text };
}

export function deleteQuestion(user: User, qid: string) {
  const { q } = ownQuestion(user, qid);
  const used = getDb().prepare("SELECT COUNT(*) AS n FROM entries WHERE guiding_question_id = ?").get(q.id) as { n: number };
  if (used.n > 0) {
    throw conflict("Groups have already responded to this question, so it cannot be deleted. Edit its wording instead.", "QUESTION_IN_USE");
  }
  getDb().prepare("DELETE FROM guiding_questions WHERE id = ?").run(q.id);
  return { deleted: true };
}

// ---------- status, stage gates and overrides ----------

export interface PartCounts {
  active: number;
  submitted: number;
  missing: Array<{ id: string; code: string; name: string }>;
}

export function partCounts(sessionId: string, part: 1 | 2): PartCounts {
  const rows = getDb()
    .prepare(
      `SELECT g.id, g.code, g.name,
         EXISTS (SELECT 1 FROM group_submissions gs WHERE gs.group_id = g.id AND gs.part = ?) AS submitted
       FROM groups g WHERE g.session_id = ? AND g.active = 1 ORDER BY g.code`,
    )
    .all(part, sessionId) as Array<{ id: string; code: string; name: string; submitted: number }>;
  return {
    active: rows.length,
    submitted: rows.filter((r) => r.submitted).length,
    missing: rows.filter((r) => !r.submitted).map((r) => ({ id: r.id, code: r.code, name: r.name })),
  };
}

function coveringOverride(sessionId: string, part: 1 | 2, missingIds: string[]) {
  const rows = getDb()
    .prepare("SELECT * FROM session_overrides WHERE session_id = ? AND part = ? ORDER BY created_at DESC")
    .all(sessionId, part) as Array<{ id: string; reason: string; missing_group_ids_json: string; created_at: string; created_by: string }>;
  for (const r of rows) {
    const covered = new Set(JSON.parse(r.missing_group_ids_json) as string[]);
    if (missingIds.every((m) => covered.has(m))) return r;
  }
  return null;
}

/** Is it OK to run a whole-session step for this part? Either everyone submitted, or a deliberate override covers the missing groups. */
export function stageGate(sessionId: string, part: 1 | 2): { ok: boolean; counts: PartCounts; override_id: string | null } {
  const counts = partCounts(sessionId, part);
  if (counts.active === 0) return { ok: false, counts, override_id: null };
  if (counts.missing.length === 0) return { ok: true, counts, override_id: null };
  const o = coveringOverride(sessionId, part, counts.missing.map((m) => m.id));
  return { ok: !!o, counts, override_id: o?.id ?? null };
}

export function recordOverride(user: User, sessionId: string, part: 1 | 2, input: unknown) {
  const s = requireSessionOwner(user, sessionId);
  const rec = asRecord(input);
  const reason = str(rec.reason, "Reason", 500, { required: true });
  if (reason.length < 5) throw invalid("Please give a short reason for proceeding without the missing groups");
  if (rec.confirm !== "OVERRIDE") throw invalid('Type OVERRIDE (in capitals) to confirm that you are proceeding without the missing groups');
  const counts = partCounts(s.id, part);
  if (counts.active === 0) throw conflict("There are no active groups", "NO_ACTIVE_GROUPS");
  if (counts.missing.length === 0) throw conflict("Every active group has already submitted, so no override is needed", "NO_OVERRIDE_NEEDED");
  const id = uid();
  getDb()
    .prepare("INSERT INTO session_overrides (id, session_id, part, reason, missing_group_ids_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, s.id, part, reason, JSON.stringify(counts.missing.map((m) => m.id)), user.id, now());
  audit(s.id, user.id, "override_recorded", { part, missing: counts.missing.map((m) => m.code), reason });
  return { id, part, missing: counts.missing, reason };
}

export function unlockPart2(user: User, sessionId: string, bodyRaw: unknown) {
  const s = requireSessionOwner(user, sessionId);
  if (s.part2_unlocked_at) return { already_unlocked: true, part2_unlocked_at: s.part2_unlocked_at };
  const body = asRecord(bodyRaw);
  const db = getDb();
  const qCount = (db.prepare("SELECT COUNT(*) AS n FROM guiding_questions WHERE session_id = ?").get(s.id) as { n: number }).n;
  if (qCount === 0) throw conflict("Add at least one guiding question before unlocking Part 2", "NO_GUIDING_QUESTIONS");
  let gate = stageGate(s.id, 1);
  if (gate.counts.active === 0) throw conflict("There are no active groups", "NO_ACTIVE_GROUPS");
  if (!gate.ok) {
    if (!body.override) {
      throw conflict(
        `${gate.counts.submitted} of ${gate.counts.active} active groups have submitted Part 1. Confirm the override to unlock without: ${gate.counts.missing.map((m) => m.name).join(", ")}.`,
        "MISSING_SUBMISSIONS",
        { counts: gate.counts },
      );
    }
    recordOverride(user, s.id, 1, body.override);
    gate = stageGate(s.id, 1);
  }
  const t = now();
  db.prepare("UPDATE pd_sessions SET part2_unlocked_at = ?, part2_unlocked_by = ? WHERE id = ? AND part2_unlocked_at IS NULL").run(t, user.id, s.id);
  audit(s.id, user.id, "part2_unlocked", { override_id: gate.override_id, missing: gate.counts.missing.map((m) => m.code) });
  return { already_unlocked: false, part2_unlocked_at: t };
}

// ---------- dashboard and reading contributions ----------

export function dashboard(user: User, sessionId: string) {
  const s = requireSessionOwner(user, sessionId);
  const db = getDb();
  const groups = db.prepare("SELECT * FROM groups WHERE session_id = ? ORDER BY code").all(s.id) as Group[];
  const partInfo = (gid: string, part: 1 | 2) => {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT author_id) AS authors, MAX(updated_at) AS last_activity
         FROM entries WHERE group_id = ? AND part = ? AND deleted_at IS NULL
         AND (observation != '' OR evidence != '' OR interpretation != '' OR question != '')`,
      )
      .get(gid, part) as { n: number; authors: number; last_activity: string | null };
    const sub = db
      .prepare(
        `SELECT gs.submitted_at, u.name FROM group_submissions gs JOIN users u ON u.id = gs.submitted_by WHERE gs.group_id = ? AND gs.part = ?`,
      )
      .get(gid, part) as { submitted_at: string; name: string } | undefined;
    let status: "locked" | "not_started" | "draft" | "submitted" = "not_started";
    if (part === 2 && !s.part2_unlocked_at) status = "locked";
    else if (sub) status = "submitted";
    else if (agg.n > 0) status = "draft";
    return {
      status,
      entry_count: agg.n,
      contributors: agg.authors,
      last_activity: agg.last_activity,
      submitted_at: sub?.submitted_at ?? null,
      submitted_by: sub?.name ?? null,
    };
  };
  const rows = groups.map((g) => {
    const members = db
      .prepare("SELECT u.id, u.name FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.name")
      .all(g.id);
    const authorised = (db.prepare("SELECT COUNT(*) AS n FROM group_authorisations WHERE group_id = ?").get(g.id) as { n: number }).n;
    const shared = (db
      .prepare("SELECT COUNT(*) AS n FROM entry_shares sh JOIN entries e ON e.id = sh.entry_id WHERE e.group_id = ?")
      .get(g.id) as { n: number }).n;
    return {
      id: g.id,
      code: g.code,
      name: g.name,
      active: !!g.active,
      authorised_count: authorised,
      members,
      shared_count: shared,
      part1: partInfo(g.id, 1),
      part2: partInfo(g.id, 2),
    };
  });
  const gate1 = stageGate(s.id, 1);
  const gate2 = stageGate(s.id, 2);
  const ov = db.prepare("SELECT id, part, reason, created_at, missing_group_ids_json FROM session_overrides WHERE session_id = ? ORDER BY created_at DESC").all(s.id) as Array<{
    id: string;
    part: number;
    reason: string;
    created_at: string;
    missing_group_ids_json: string;
  }>;
  return {
    session: { id: s.id, title: s.title, join_code: s.join_code, part2_unlocked_at: s.part2_unlocked_at, sharing_enabled: !!s.sharing_enabled },
    groups: rows,
    progress: {
      part1: { ...gate1.counts, override_active: gate1.override_id !== null, ready: gate1.ok },
      part2: { ...gate2.counts, override_active: gate2.override_id !== null, ready: gate2.ok },
    },
    overrides: ov.map((o) => ({ id: o.id, part: o.part, reason: o.reason, created_at: o.created_at, missing_group_ids: JSON.parse(o.missing_group_ids_json) })),
  };
}

export function groupContributions(user: User, sessionId: string, groupId: string) {
  const s = requireSessionOwner(user, sessionId);
  const db = getDb();
  const group = db.prepare("SELECT * FROM groups WHERE id = ? AND session_id = ?").get(groupId, s.id) as Group | undefined;
  if (!group) throw notFound("Group not found");
  const subs = db.prepare("SELECT part, submitted_at, u.name AS submitted_by FROM group_submissions gs JOIN users u ON u.id = gs.submitted_by WHERE gs.group_id = ?").all(group.id) as Array<{
    part: number;
    submitted_at: string;
    submitted_by: string;
  }>;
  const rows = db
    .prepare(
      `SELECT e.*, u.name AS author_name, sh.show_author, (sh.entry_id IS NOT NULL) AS shared
       FROM entries e JOIN users u ON u.id = e.author_id LEFT JOIN entry_shares sh ON sh.entry_id = e.id
       WHERE e.group_id = ? AND e.deleted_at IS NULL ORDER BY e.part, e.seq`,
    )
    .all(group.id) as Array<EntryRow & { author_name: string; show_author: number | null; shared: number }>;
  const entry = (r: (typeof rows)[number]) => ({
    id: r.id,
    public_id: r.public_id,
    part: r.part,
    stage_label: STAGE_LABELS[r.part],
    author: { id: r.author_id, name: r.author_name },
    observation: r.observation,
    timestamp_sec: r.timestamp_sec,
    evidence: r.evidence,
    interpretation: r.interpretation,
    question: r.question,
    guiding_question_id: r.guiding_question_id,
    version: r.version,
    created_at: r.created_at,
    updated_at: r.updated_at,
    submitted: subs.some((x) => x.part === r.part),
    shared: !!r.shared,
    show_author: !!r.show_author,
  });
  return {
    group: { id: group.id, code: group.code, name: group.name, active: !!group.active },
    submissions: subs,
    entries: rows.map(entry),
  };
}

// ---------- controlled sharing ----------

export function shareEntry(user: User, entryId: string, bodyRaw: unknown) {
  requireFacilitator(user);
  const db = getDb();
  const e = db.prepare("SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL").get(entryId) as EntryRow | undefined;
  if (!e) throw notFound("Entry not found");
  const s = requireSessionOwner(user, e.session_id);
  const body = asRecord(bodyRaw);
  const shared = body.shared !== false;
  if (shared) {
    const sub = db.prepare("SELECT 1 FROM group_submissions WHERE group_id = ? AND part = ?").get(e.group_id, e.part);
    if (!sub) throw conflict("Only entries from a part the group has submitted can be shared", "NOT_SUBMITTED");
    db.prepare(
      `INSERT INTO entry_shares (entry_id, session_id, shared_by, shared_at, show_author) VALUES (?,?,?,?,?)
       ON CONFLICT(entry_id) DO UPDATE SET show_author = excluded.show_author`,
    ).run(e.id, s.id, user.id, now(), body.show_author ? 1 : 0);
    audit(s.id, user.id, "entry_shared", { entry_id: e.id, public_id: e.public_id, show_author: !!body.show_author });
  } else {
    db.prepare("DELETE FROM entry_shares WHERE entry_id = ?").run(e.id);
    audit(s.id, user.id, "entry_unshared", { entry_id: e.id, public_id: e.public_id });
  }
  return { entry_id: e.id, shared };
}

export { forbidden };
