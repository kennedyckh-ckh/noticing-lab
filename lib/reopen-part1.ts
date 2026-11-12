import { getDb } from "./db";
import { requireSessionOwner } from "./authz";
import { asRecord, audit, conflict, invalid, notFound, now, str, uid } from "./util";
import type { Group, User } from "./types";

// Additive tables only. Existing session, entry and AI schemas stay unchanged.
export function ensureReopenTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS part1_submission_history (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL UNIQUE,
      submitted_by TEXT NOT NULL REFERENCES users(id),
      submitted_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      reopened_by TEXT NOT NULL REFERENCES users(id),
      reopened_at TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reopened_ai_outputs (
      output_id TEXT PRIMARY KEY REFERENCES ai_outputs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
      invalidated_at TEXT NOT NULL
    );
  `);
}

export function reopenPart1(user: User, sessionId: string, groupId: string, bodyRaw: unknown) {
  requireSessionOwner(user, sessionId);
  const body = asRecord(bodyRaw);
  const reason = str(body.reason, "Reason for reopening", 500, { required: true });
  if (reason.length < 5) throw invalid("Give a short reason of at least 5 characters.");
  if (body.confirm !== "REOPEN") throw invalid("Type REOPEN to confirm.");
  if (typeof body.submitted_at !== "string") throw invalid("Refresh the group's contributions before reopening.");
  ensureReopenTables();
  const db = getDb();
  return db.transaction(() => {
    const session = requireSessionOwner(user, sessionId);
    const group = db.prepare("SELECT * FROM groups WHERE id = ? AND session_id = ?").get(groupId, session.id) as Group | undefined;
    if (!group) throw notFound("Group not found");
    if (!group.active) throw conflict("Mark this group active before reopening its work.", "GROUP_INACTIVE");
    const submission = db.prepare(
      "SELECT id, submitted_by, submitted_at, snapshot_json FROM group_submissions WHERE group_id = ? AND part = 1",
    ).get(group.id) as { id: string; submitted_by: string; submitted_at: string; snapshot_json: string } | undefined;
    if (!submission) throw conflict("Part 1 is not currently submitted. Refresh the contributions.", "NOT_SUBMITTED");
    if (body.submitted_at !== submission.submitted_at) {
      throw conflict("The group has submitted a newer version. Refresh and review it before reopening.", "SUBMISSION_CHANGED");
    }
    const t = now();
    const historyId = uid();
    db.prepare(`
      INSERT INTO part1_submission_history
      (id, session_id, group_id, submission_id, submitted_by, submitted_at, snapshot_json, reopened_by, reopened_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(historyId, session.id, group.id, submission.id, submission.submitted_by, submission.submitted_at, submission.snapshot_json, user.id, t, reason);

    const outputs = db.prepare(`
      SELECT id, warnings_json FROM ai_outputs WHERE session_id = ?
      AND part IN ('1', 'both') AND (group_id = ? OR group_id IS NULL)
    `).all(session.id, group.id) as Array<{ id: string; warnings_json: string }>;
    const warning = "OUTDATED: Part 1 was reopened for editing. Do not reuse this analysis. Generate a new draft from the resubmitted work, then review and publish it.";
    for (const output of outputs) {
      const warnings = JSON.parse(output.warnings_json) as string[];
      db.prepare("INSERT OR IGNORE INTO reopened_ai_outputs (output_id, session_id, invalidated_at) VALUES (?, ?, ?)").run(output.id, session.id, t);
      db.prepare(`
        UPDATE ai_outputs SET status = 'draft', reviewed_at = NULL, reviewed_by = NULL,
        published_json = NULL, published_at = NULL, published_by = NULL, warnings_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify([...new Set([warning, ...warnings])]), t, output.id);
    }
    // Previously shared live entries must not silently reappear when resubmitted.
    const unshared = db.prepare(`
      DELETE FROM entry_shares WHERE entry_id IN
      (SELECT id FROM entries WHERE session_id = ? AND group_id = ? AND part = 1)
    `).run(session.id, group.id).changes;
    db.prepare("DELETE FROM group_submissions WHERE id = ?").run(submission.id);
    audit(session.id, user.id, "part1_reopened", {
      group_id: group.id, previous_submission_id: submission.id,
      history_id: historyId, reason, affected_ai_outputs: outputs.length, unshared_entries: unshared,
    });
    return { reopened: true, group_id: group.id, part: 1, history_id: historyId, invalidated_ai_outputs: outputs.length, unshared_entries: unshared };
  })();
}

export function assertAiOutputCurrent(outputId: string) {
  ensureReopenTables();
  if (getDb().prepare("SELECT 1 FROM reopened_ai_outputs WHERE output_id = ?").get(outputId)) {
    throw conflict("This analysis is outdated because Part 1 was reopened. Generate a new draft after resubmission instead.", "AI_OUTDATED");
  }
}

/** Detect reopen/resubmit while a model request is awaiting its response. */
export function submissionScopeToken(sessionId: string, parts: number[], groupId: string | null): string {
  const rows = getDb().prepare(`
    SELECT s.id, s.group_id, s.part, g.active FROM group_submissions s
    JOIN groups g ON g.id = s.group_id WHERE s.session_id = ? ORDER BY s.group_id, s.part
  `).all(sessionId) as Array<{ id: string; group_id: string; part: number; active: number }>;
  return JSON.stringify(rows.filter((r) => parts.includes(r.part) && (groupId ? r.group_id === groupId : !!r.active)));
}

/** Included in the complete JSON export; contains personal data like other snapshots. */
export function previousPart1Submissions(sessionId: string) {
  ensureReopenTables();
  const rows = getDb().prepare(`
    SELECT h.*, g.code AS group_code, g.name AS group_name FROM part1_submission_history h
    JOIN groups g ON g.id = h.group_id WHERE h.session_id = ? ORDER BY h.reopened_at, h.id
  `).all(sessionId) as Array<Record<string, unknown> & { snapshot_json: string }>;
  return rows.map(({ snapshot_json, ...row }) => ({ ...row, snapshot: JSON.parse(snapshot_json) }));
}

