/**
 * Server-side permission guards. Every route that touches session, group or entry data
 * goes through one of these. Resources a user has no relationship to answer 404 (so that
 * ids cannot be probed); role and stage-release failures answer 403.
 */
import { getDb } from "./db";
import { forbidden, notFound } from "./util";
import type { EntryRow, Group, PdSession, User } from "./types";

export function getSession(sessionId: string): PdSession | undefined {
  return getDb().prepare("SELECT * FROM pd_sessions WHERE id = ?").get(sessionId) as PdSession | undefined;
}

export function requireFacilitator(user: User): void {
  if (user.role !== "facilitator") throw forbidden("Facilitator access required", "FACILITATOR_ONLY");
}
export function requireParticipant(user: User): void {
  if (user.role !== "participant") throw forbidden("Participant access required", "PARTICIPANT_ONLY");
}

/** The facilitator who owns this PD session. */
export function requireSessionOwner(user: User, sessionId: string): PdSession {
  requireFacilitator(user);
  const s = getSession(sessionId);
  if (!s || s.facilitator_id !== user.id) throw notFound("Session not found");
  return s;
}

/** A participant who joined this session with its code and is still on its roster. */
export function requireSessionMember(user: User, sessionId: string): PdSession {
  requireParticipant(user);
  const s = getSession(sessionId);
  if (!s) throw notFound("Session not found");
  const db = getDb();
  const member = db
    .prepare("SELECT 1 FROM session_members WHERE session_id = ? AND user_id = ?")
    .get(sessionId, user.id);
  if (!member) throw notFound("Session not found");
  return s;
}

/**
 * A participant acting inside a group. Requires ALL of: joined the session, chose this group,
 * and is (still) authorised for it. Removing an authorisation revokes access immediately.
 */
export function requireGroupAccess(user: User, groupId: string): { group: Group; session: PdSession } {
  requireParticipant(user);
  const db = getDb();
  const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as Group | undefined;
  if (!group) throw notFound("Group not found");
  const session = requireSessionMember(user, group.session_id);
  const chosen = db
    .prepare("SELECT 1 FROM group_members WHERE session_id = ? AND user_id = ? AND group_id = ?")
    .get(session.id, user.id, group.id);
  const authorised = db
    .prepare("SELECT 1 FROM group_authorisations WHERE group_id = ? AND user_id = ?")
    .get(group.id, user.id);
  if (!chosen || !authorised) throw notFound("Group not found");
  return { group, session };
}

export function requireEntryAccess(user: User, entryId: string): { entry: EntryRow; group: Group; session: PdSession } {
  const entry = getDb().prepare("SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL").get(entryId) as
    | EntryRow
    | undefined;
  if (!entry) throw notFound("Entry not found");
  const { group, session } = requireGroupAccess(user, entry.group_id);
  return { entry, group, session };
}

export function isPart2Open(session: PdSession): boolean {
  return session.part2_unlocked_at !== null;
}

export function requirePart2Open(session: PdSession): void {
  if (!isPart2Open(session)) {
    throw forbidden("Part 2 has not been unlocked by the facilitator yet", "PART2_LOCKED");
  }
}
