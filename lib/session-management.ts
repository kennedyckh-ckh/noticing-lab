import { getDb } from "./db";
import { requireFacilitator, requireSessionOwner } from "./authz";
import { asRecord, audit, conflict, invalid, now } from "./util";
import type { User } from "./types";

/**
 * Additive schema only: old app versions can continue to use the same database.
 * Archiving organises the facilitator's list; it does NOT close participant access.
 */
function ensureArchiveTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS facilitator_session_archives (
      session_id TEXT PRIMARY KEY REFERENCES pd_sessions(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL,
      archived_by TEXT NOT NULL REFERENCES users(id)
    );
  `);
}

export function listManagedSessions(user: User) {
  requireFacilitator(user);
  ensureArchiveTable();
  const sessions = getDb().prepare(`
    SELECT s.id, s.title, s.description, s.join_code, s.part2_unlocked_at, s.created_at,
      a.archived_at,
      (SELECT COUNT(*) FROM groups g WHERE g.session_id = s.id AND g.active = 1) AS active_groups,
      (SELECT COUNT(*) FROM session_members m WHERE m.session_id = s.id) AS joined,
      (SELECT COUNT(*) FROM entries e WHERE e.session_id = s.id AND e.deleted_at IS NULL) AS entry_count
    FROM pd_sessions s
    LEFT JOIN facilitator_session_archives a ON a.session_id = s.id
    WHERE s.facilitator_id = ? ORDER BY s.created_at DESC
  `).all(user.id);
  return { sessions };
}

export function setSessionArchived(user: User, sessionId: string, bodyRaw: unknown) {
  // Authorise before even creating the auxiliary table.
  requireSessionOwner(user, sessionId);
  const body = asRecord(bodyRaw);
  if (typeof body.archived !== "boolean") throw invalid("archived must be true or false");
  ensureArchiveTable();
  const db = getDb();
  return db.transaction(() => {
    const s = requireSessionOwner(user, sessionId);
    if (body.archived) {
      const changed = db.prepare(`
        INSERT OR IGNORE INTO facilitator_session_archives (session_id, archived_at, archived_by)
        VALUES (?, ?, ?)
      `).run(s.id, now(), user.id).changes;
      if (changed) audit(s.id, user.id, "session_archived", {});
    } else {
      const changed = db.prepare(
        "DELETE FROM facilitator_session_archives WHERE session_id = ?"
      ).run(s.id).changes;
      if (changed) audit(s.id, user.id, "session_restored", {});
    }
    return { id: s.id, archived: body.archived };
  })();
}

/**
 * Explicit destructive operation. Never run automatically on archive.
 * Users/auth_sessions are intentionally NOT deleted. Session children cascade
 * using the existing foreign keys; the transaction rolls back on any failure.
 */
export function deleteManagedSession(user: User, sessionId: string, bodyRaw: unknown) {
  requireSessionOwner(user, sessionId);
  const body = asRecord(bodyRaw);
  ensureArchiveTable();
  const db = getDb();
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw conflict("Database foreign-key protection is off. Nothing was deleted.", "DELETE_UNSAFE");
  }
  return db.transaction(() => {
    const s = requireSessionOwner(user, sessionId);
    if (!db.prepare("SELECT 1 FROM facilitator_session_archives WHERE session_id = ?").get(s.id)) {
      throw conflict("Archive this session before permanently deleting it.", "ARCHIVE_FIRST");
    }
    if (body.confirm_title !== s.title) {
      throw invalid("Type the full session title exactly to confirm deletion.");
    }
    if (body.acknowledge_data_loss !== true) {
      throw invalid("Confirm you have exported any data you need, or intentionally do not need it.");
    }
    db.prepare("DELETE FROM audit_log WHERE session_id = ?").run(s.id);
    db.prepare("DELETE FROM pd_sessions WHERE id = ? AND facilitator_id = ?").run(s.id, user.id);
    // Minimal admin record, without participant text, names, or emails.
    audit(null, user.id, "session_deleted", { deleted_session_id: s.id });
    return { deleted: true, id: s.id };
  })();
}

