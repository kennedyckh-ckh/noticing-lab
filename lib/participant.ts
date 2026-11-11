import crypto from "node:crypto";
import { getDb } from "./db";
import {
  isPart2Open,
  requireEntryAccess,
  requireGroupAccess,
  requireParticipant,
  requirePart2Open,
  requireSessionMember,
} from "./authz";
import { throttleCheck, throttleFail, throttleClear } from "./auth";
import { HttpError, asRecord, audit, conflict, forbidden, invalid, notFound, now, parseTimestamp, str, uid } from "./util";
import { STAGE_LABELS, type EntryRow, type Group, type PdSession, type User } from "./types";

export const MAX_ENTRIES_PER_AUTHOR_PART = 100;

const LIMITS = { observation: 3000, evidence: 3000, interpretation: 3000, question: 1000 } as const;

// ---------- joining a session and choosing a group ----------

export function joinSession(user: User, codeRaw: unknown): { session_id: string } {
  requireParticipant(user);
  const code = typeof codeRaw === "string" ? codeRaw.replace(/\s+/g, "").toUpperCase() : "";
  if (code.length < 4 || code.length > 12) throw invalid("Enter the join code your facilitator gave you");
  const key = `join|${user.id}`;
  throttleCheck(key);
  const db = getDb();
  const session = db.prepare("SELECT * FROM pd_sessions WHERE join_code = ?").get(code) as PdSession | undefined;
  if (!session) {
    throttleFail(key);
    throw new HttpError(404, "That join code was not recognised", "INVALID_CODE");
  }
  throttleClear(key);
  const onRoster = db
    .prepare(
      `SELECT 1 FROM group_authorisations a JOIN groups g ON g.id = a.group_id
       WHERE g.session_id = ? AND a.user_id = ? LIMIT 1`,
    )
    .get(session.id, user.id);
  if (!onRoster) {
    throw forbidden("You have not been added to this session. Please ask your facilitator to add you to a group.", "NOT_ON_ROSTER");
  }
  db.prepare("INSERT OR IGNORE INTO session_members (session_id, user_id, joined_at) VALUES (?,?,?)").run(
    session.id,
    user.id,
    now(),
  );
  audit(session.id, user.id, "joined_session", {});
  return { session_id: session.id };
}

export function mySessions(user: User) {
  requireParticipant(user);
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.title, s.description, s.part2_unlocked_at, g.id AS group_id, g.code AS group_code, g.name AS group_name
       FROM session_members m
       JOIN pd_sessions s ON s.id = m.session_id
       LEFT JOIN group_members gm ON gm.session_id = s.id AND gm.user_id = m.user_id
       LEFT JOIN groups g ON g.id = gm.group_id
       WHERE m.user_id = ? ORDER BY m.joined_at DESC`,
    )
    .all(user.id) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    part2_unlocked: r.part2_unlocked_at !== null,
    group: r.group_id ? { id: r.group_id, code: r.group_code, name: r.group_name } : null,
  }));
}

function publicSessionInfo(s: PdSession) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    video_title: s.video_title,
    video_url: s.video_url,
    part2_unlocked: isPart2Open(s),
    sharing_enabled: !!s.sharing_enabled,
  };
}

export function sessionOverview(user: User, sessionId: string) {
  const session = requireSessionMember(user, sessionId);
  const db = getDb();
  const authorised = db
    .prepare(
      `SELECT g.id, g.code, g.name, g.active,
         (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
       FROM groups g JOIN group_authorisations a ON a.group_id = g.id
       WHERE g.session_id = ? AND a.user_id = ? ORDER BY g.code`,
    )
    .all(session.id, user.id) as Array<Record<string, unknown>>;
  const sel = db
    .prepare("SELECT group_id FROM group_members WHERE session_id = ? AND user_id = ?")
    .get(session.id, user.id) as { group_id: string } | undefined;
  return {
    session: publicSessionInfo(session),
    authorised_groups: authorised.map((g) => ({ ...g, active: !!g.active })),
    selected_group_id: sel?.group_id ?? null,
  };
}

export function selectGroup(user: User, sessionId: string, groupIdRaw: unknown): { group_id: string } {
  const session = requireSessionMember(user, sessionId);
  if (typeof groupIdRaw !== "string") throw invalid("Choose a group");
  const db = getDb();
  const group = db.prepare("SELECT * FROM groups WHERE id = ? AND session_id = ?").get(groupIdRaw, session.id) as
    | Group
    | undefined;
  const authorised =
    group && db.prepare("SELECT 1 FROM group_authorisations WHERE group_id = ? AND user_id = ?").get(group.id, user.id);
  if (!group || !authorised) throw forbidden("You are not authorised to join that group", "NOT_AUTHORISED_FOR_GROUP");
  if (!group.active) throw conflict("That group is not active in this session", "GROUP_INACTIVE");
  const current = db.prepare("SELECT group_id FROM group_members WHERE session_id = ? AND user_id = ?").get(session.id, user.id) as
    | { group_id: string }
    | undefined;
  if (current && current.group_id === group.id) return { group_id: group.id };
  if (current) {
    const authored = db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE group_id = ? AND author_id = ? AND deleted_at IS NULL")
      .get(current.group_id, user.id) as { n: number };
    if (authored.n > 0) {
      throw conflict(
        "You have already written entries in your current group, so you cannot switch. Ask your facilitator if this is a mistake.",
        "HAS_ENTRIES",
      );
    }
  }
  db.prepare(
    `INSERT INTO group_members (session_id, user_id, group_id, selected_at) VALUES (?,?,?,?)
     ON CONFLICT(session_id, user_id) DO UPDATE SET group_id = excluded.group_id, selected_at = excluded.selected_at`,
  ).run(session.id, user.id, group.id, now());
  audit(session.id, user.id, "selected_group", { group_id: group.id });
  return { group_id: group.id };
}

// ---------- entries ----------

interface EntryWithAuthor extends EntryRow {
  author_name: string;
}

function serialiseEntry(e: EntryWithAuthor, viewerId: string, locked: boolean) {
  return {
    id: e.id,
    public_id: e.public_id,
    part: e.part,
    stage_label: STAGE_LABELS[e.part],
    author: { id: e.author_id, name: e.author_name },
    mine: e.author_id === viewerId,
    observation: e.observation,
    timestamp_sec: e.timestamp_sec,
    evidence: e.evidence,
    interpretation: e.interpretation,
    question: e.question,
    guiding_question_id: e.guiding_question_id,
    version: e.version,
    created_at: e.created_at,
    updated_at: e.updated_at,
    locked,
  };
}

export function entriesDigest(groupId: string, part: number): string {
  const rows = getDb()
    .prepare("SELECT id, version FROM entries WHERE group_id = ? AND part = ? AND deleted_at IS NULL ORDER BY id")
    .all(groupId, part) as Array<{ id: string; version: number }>;
  return crypto.createHash("sha1").update(rows.map((r) => `${r.id}:${r.version}`).join("|")).digest("hex").slice(0, 16);
}

interface SubmissionRow {
  submitted_at: string;
  submitted_by: string;
  submitter_name: string;
}

function getSubmission(groupId: string, part: number): SubmissionRow | undefined {
  return getDb()
    .prepare(
      `SELECT s.submitted_at, s.submitted_by, u.name AS submitter_name
       FROM group_submissions s JOIN users u ON u.id = s.submitted_by WHERE s.group_id = ? AND s.part = ?`,
    )
    .get(groupId, part) as SubmissionRow | undefined;
}

function partEntries(groupId: string, part: number): EntryWithAuthor[] {
  return getDb()
    .prepare(
      `SELECT e.*, u.name AS author_name FROM entries e JOIN users u ON u.id = e.author_id
       WHERE e.group_id = ? AND e.part = ? AND e.deleted_at IS NULL ORDER BY e.seq`,
    )
    .all(groupId, part) as EntryWithAuthor[];
}

export function workspace(user: User, groupId: string) {
  const { group, session } = requireGroupAccess(user, groupId);
  const db = getDb();
  const members = db
    .prepare(
      `SELECT u.id, u.name FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? ORDER BY u.name`,
    )
    .all(group.id);
  const sub1 = getSubmission(group.id, 1);
  const part1 = {
    status: sub1 ? "submitted" : "draft",
    submitted_at: sub1?.submitted_at ?? null,
    submitted_by: sub1?.submitter_name ?? null,
    entries: partEntries(group.id, 1).map((e) => serialiseEntry(e, user.id, !!sub1)),
    digest: entriesDigest(group.id, 1),
  };
  const open2 = isPart2Open(session);
  let part2: Record<string, unknown> = { locked: true, status: "locked", entries: [], digest: "" };
  let questions: Array<{ id: string; position: number; text: string }> = [];
  if (open2) {
    const sub2 = getSubmission(group.id, 2);
    part2 = {
      locked: false,
      status: sub2 ? "submitted" : "draft",
      submitted_at: sub2?.submitted_at ?? null,
      submitted_by: sub2?.submitter_name ?? null,
      needs_part1_first: !sub1,
      entries: partEntries(group.id, 2).map((e) => serialiseEntry(e, user.id, !!sub2)),
      digest: entriesDigest(group.id, 2),
    };
    // Guiding questions are only sent once the facilitator has released Part 2.
    questions = db
      .prepare("SELECT id, position, text FROM guiding_questions WHERE session_id = ? ORDER BY position")
      .all(session.id) as typeof questions;
  }
  return {
    group: { id: group.id, code: group.code, name: group.name, active: !!group.active },
    session: publicSessionInfo(session),
    me: { id: user.id, name: user.name },
    members,
    part1,
    part2,
    guiding_questions: questions,
  };
}

function submittedPartGuard(groupId: string, part: number): void {
  if (getSubmission(groupId, part)) {
    throw conflict(`Part ${part} has already been submitted by your group and is now locked`, "PART_SUBMITTED");
  }
}

function partGuards(group: Group, session: PdSession, part: number): void {
  if (!group.active) throw conflict("Your group is not active in this session", "GROUP_INACTIVE");
  if (part === 2) {
    requirePart2Open(session);
    if (!getSubmission(group.id, 1)) {
      throw conflict("Your group needs to submit Part 1 before adding Part 2 entries", "PART1_NOT_SUBMITTED");
    }
  }
  submittedPartGuard(group.id, part);
}

function validateGuidingQuestion(sessionId: string, v: unknown, part: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw invalid("Invalid guiding question");
  if (part !== 2) throw invalid("Only Part 2 entries can be linked to a guiding question");
  const q = getDb().prepare("SELECT 1 FROM guiding_questions WHERE id = ? AND session_id = ?").get(v, sessionId);
  if (!q) throw invalid("That guiding question does not belong to this session");
  return v;
}

export function createEntry(user: User, groupId: string, bodyRaw: unknown) {
  const body = asRecord(bodyRaw);
  const { group, session } = requireGroupAccess(user, groupId);
  const part = body.part === 1 || body.part === 2 ? body.part : null;
  if (!part) throw invalid("part must be 1 or 2");
  const db = getDb();
  const tx = db.transaction(() => {
    partGuards(group, session, part);
    const mine = db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE group_id = ? AND part = ? AND author_id = ? AND deleted_at IS NULL")
      .get(group.id, part, user.id) as { n: number };
    if (mine.n >= MAX_ENTRIES_PER_AUTHOR_PART) throw conflict("Entry limit reached", "ENTRY_LIMIT");
    const gq = validateGuidingQuestion(session.id, body.guiding_question_id, part);
    const seqRow = db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS next FROM entries WHERE group_id = ? AND part = ?").get(group.id, part) as {
      next: number;
    };
    const id = uid();
    const t = now();
    const publicId = `${group.code}-P${part}-${String(seqRow.next).padStart(2, "0")}`;
    db.prepare(
      `INSERT INTO entries (id, session_id, group_id, part, seq, public_id, author_id, observation, timestamp_sec, evidence,
         interpretation, question, guiding_question_id, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    ).run(
      id,
      session.id,
      group.id,
      part,
      seqRow.next,
      publicId,
      user.id,
      str(body.observation, "Observation", LIMIT("observation"), { trim: false }),
      parseTimestamp(body.timestamp),
      str(body.evidence, "Evidence", LIMIT("evidence"), { trim: false }),
      str(body.interpretation, "Interpretation", LIMIT("interpretation"), { trim: false }),
      str(body.question, "Question", LIMIT("question"), { trim: false }),
      gq,
      t,
      t,
    );
    return id;
  });
  const id = tx();
  const row = db
    .prepare(`SELECT e.*, u.name AS author_name FROM entries e JOIN users u ON u.id = e.author_id WHERE e.id = ?`)
    .get(id) as EntryWithAuthor;
  return { entry: serialiseEntry(row, user.id, false) };
}

function LIMIT(k: keyof typeof LIMITS): number {
  return LIMITS[k];
}

export function updateEntry(user: User, entryId: string, bodyRaw: unknown) {
  const body = asRecord(bodyRaw);
  const { entry, group, session } = requireEntryAccess(user, entryId);
  if (entry.author_id !== user.id) {
    throw forbidden("You can only edit entries that you wrote. Add your own entry instead.", "NOT_AUTHOR");
  }
  partGuards(group, session, entry.part);
  if (!Number.isInteger(body.base_version)) throw invalid("base_version is required");
  const db = getDb();
  const tx = db.transaction(() => {
    const cur = db.prepare("SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL").get(entryId) as EntryRow | undefined;
    if (!cur) throw notFound("Entry not found");
    if (cur.version !== body.base_version) {
      throw conflict(
        "This entry was changed somewhere else (for example in another tab). Your text is kept on this page: review it, then reload the latest version.",
        "VERSION_CONFLICT",
        { current_version: cur.version },
      );
    }
    const next = {
      observation: "observation" in body ? str(body.observation, "Observation", LIMIT("observation"), { trim: false }) : cur.observation,
      evidence: "evidence" in body ? str(body.evidence, "Evidence", LIMIT("evidence"), { trim: false }) : cur.evidence,
      interpretation:
        "interpretation" in body ? str(body.interpretation, "Interpretation", LIMIT("interpretation"), { trim: false }) : cur.interpretation,
      question: "question" in body ? str(body.question, "Question", LIMIT("question"), { trim: false }) : cur.question,
      timestamp_sec: "timestamp" in body ? parseTimestamp(body.timestamp) : cur.timestamp_sec,
      guiding_question_id:
        "guiding_question_id" in body ? validateGuidingQuestion(session.id, body.guiding_question_id, cur.part) : cur.guiding_question_id,
    };
    const same =
      next.observation === cur.observation &&
      next.evidence === cur.evidence &&
      next.interpretation === cur.interpretation &&
      next.question === cur.question &&
      next.timestamp_sec === cur.timestamp_sec &&
      next.guiding_question_id === cur.guiding_question_id;
    if (!same) {
      db.prepare(
        `UPDATE entries SET observation=?, evidence=?, interpretation=?, question=?, timestamp_sec=?, guiding_question_id=?,
           version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(next.observation, next.evidence, next.interpretation, next.question, next.timestamp_sec, next.guiding_question_id, now(), entryId);
    }
  });
  tx();
  const row = db
    .prepare(`SELECT e.*, u.name AS author_name FROM entries e JOIN users u ON u.id = e.author_id WHERE e.id = ?`)
    .get(entryId) as EntryWithAuthor;
  return { entry: serialiseEntry(row, user.id, false), saved_at: row.updated_at };
}

export function deleteEntry(user: User, entryId: string) {
  const { entry, group, session } = requireEntryAccess(user, entryId);
  if (entry.author_id !== user.id) throw forbidden("You can only delete entries that you wrote", "NOT_AUTHOR");
  partGuards(group, session, entry.part);
  getDb().prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").run(now(), entryId);
  return { deleted: true };
}

// ---------- collective submission ----------

export function stageSnapshot(groupId: string, part: number) {
  const group = getDb().prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as Group;
  return partEntries(groupId, part).map((e) => ({
    entry_id: e.id,
    public_id: e.public_id,
    group_code: group.code,
    group_name: group.name,
    part: e.part,
    stage_label: STAGE_LABELS[e.part],
    author_id: e.author_id,
    author_name: e.author_name,
    observation: e.observation,
    timestamp_sec: e.timestamp_sec,
    evidence: e.evidence,
    interpretation: e.interpretation,
    question: e.question,
    guiding_question_id: e.guiding_question_id,
    version: e.version,
    created_at: e.created_at,
    updated_at: e.updated_at,
  }));
}

export function submitPart(user: User, groupId: string, bodyRaw: unknown) {
  const body = asRecord(bodyRaw);
  const { group, session } = requireGroupAccess(user, groupId);
  const part = body.part === 1 || body.part === 2 ? body.part : null;
  if (!part) throw invalid("part must be 1 or 2");
  if (typeof body.digest !== "string") throw invalid("digest is required: reload the workspace and try again");
  const db = getDb();
  const tx = db.transaction(() => {
    partGuards(group, session, part);
    if (entriesDigest(group.id, part) !== body.digest) {
      throw conflict(
        "A teammate changed the group's entries while you were reviewing. Please review the latest entries and submit again.",
        "DIGEST_MISMATCH",
      );
    }
    // Completely blank drafts (an "Add entry" click that was never used) are discarded.
    db.prepare(
      `UPDATE entries SET deleted_at = ? WHERE group_id = ? AND part = ? AND deleted_at IS NULL
       AND observation = '' AND evidence = '' AND interpretation = '' AND question = '' AND timestamp_sec IS NULL`,
    ).run(now(), group.id, part);
    const entries = partEntries(group.id, part);
    if (entries.length === 0) throw conflict("Add at least one noticing entry before submitting", "NO_ENTRIES");
    const incomplete = entries
      .map((e) => {
        const missing: string[] = [];
        if (!e.observation.trim()) missing.push("observation");
        if (!e.evidence.trim()) missing.push("evidence");
        if (!e.interpretation.trim()) missing.push("interpretation");
        return { public_id: e.public_id, id: e.id, missing };
      })
      .filter((x) => x.missing.length > 0);
    if (incomplete.length > 0) {
      throw conflict("Some entries are missing an observation, evidence or interpretation", "INCOMPLETE_ENTRIES", { incomplete });
    }
    const t = now();
    db.prepare(
      "INSERT INTO group_submissions (id, session_id, group_id, part, submitted_by, submitted_at, snapshot_json) VALUES (?,?,?,?,?,?,?)",
    ).run(uid(), session.id, group.id, part, user.id, t, JSON.stringify(stageSnapshot(group.id, part)));
    audit(session.id, user.id, "submitted_part", { group_id: group.id, part, entries: entries.length });
    return t;
  });
  const submittedAt = tx();
  return { submitted: true, part, submitted_at: submittedAt };
}

// ---------- controlled sharing: what a participant may see of other groups ----------

export function sharedView(user: User, sessionId: string) {
  const session = requireSessionMember(user, sessionId);
  const db = getDb();
  let entries: Array<Record<string, unknown>> = [];
  if (session.sharing_enabled) {
    const rows = db
      .prepare(
        `SELECT e.*, g.code AS group_code, g.name AS group_name, sh.show_author, u.name AS author_name
         FROM entry_shares sh
         JOIN entries e ON e.id = sh.entry_id AND e.deleted_at IS NULL
         JOIN groups g ON g.id = e.group_id
         JOIN users u ON u.id = e.author_id
         JOIN group_submissions gs ON gs.group_id = e.group_id AND gs.part = e.part
         WHERE sh.session_id = ? ORDER BY g.code, e.part, e.seq`,
      )
      .all(session.id) as Array<EntryRow & { group_code: string; group_name: string; show_author: number; author_name: string }>;
    // Whitelisted fields only; the contributor name is shown only if the facilitator chose to.
    entries = rows
      .filter((r) => r.part === 1 || isPart2Open(session))
      .map((r) => ({
        public_id: r.public_id,
        group: { code: r.group_code, name: r.group_name },
        part: r.part,
        stage_label: STAGE_LABELS[r.part],
        observation: r.observation,
        timestamp_sec: r.timestamp_sec,
        evidence: r.evidence,
        interpretation: r.interpretation,
        question: r.question,
        author_name: r.show_author ? r.author_name : null,
      }));
  }
  return { sharing_enabled: !!session.sharing_enabled, entries };
}
