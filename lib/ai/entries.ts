import { getDb } from "../db";
import { formatTimestamp } from "../util";

/** One participant entry as the AI sees it: no names, no emails, only a per-group contributor label. */
export interface EntrySnap {
  id: string; // public id, e.g. G1-P1-02: what the AI must cite
  group_code: string;
  group_name: string;
  part: 1 | 2;
  contributor: string; // C1, C2... within the group
  observation: string;
  timestamp_sec: number | null;
  evidence: string;
  interpretation: string;
  question: string;
  responding_to: string;
}

interface SnapRow {
  public_id: string;
  group_code: string;
  group_name: string;
  part: 1 | 2;
  author_id: string;
  observation: string;
  timestamp_sec: number | null;
  evidence: string;
  interpretation: string;
  question: string;
  guiding_question_id: string | null;
}

/**
 * Entries come from the immutable submission snapshots, never from live drafts, and only for
 * the requested parts and groups. This is the single place the AI's input is assembled.
 */
export function loadSnapshots(sessionId: string, opts: { parts: Array<1 | 2>; groupIds?: string[]; activeOnly?: boolean }): EntrySnap[] {
  const db = getDb();
  const subs = db
    .prepare(
      `SELECT gs.group_id, gs.part, gs.snapshot_json, g.active
       FROM group_submissions gs JOIN groups g ON g.id = gs.group_id
       WHERE gs.session_id = ? ORDER BY g.code, gs.part`,
    )
    .all(sessionId) as Array<{ group_id: string; part: number; snapshot_json: string; active: number }>;
  const questions = new Map(
    (db.prepare("SELECT id, position, text FROM guiding_questions WHERE session_id = ?").all(sessionId) as Array<{ id: string; position: number; text: string }>).map((q) => [q.id, q.text]),
  );
  const labels = new Map<string, Map<string, string>>(); // group -> author -> label
  const out: EntrySnap[] = [];
  for (const s of subs) {
    if (!opts.parts.includes(s.part as 1 | 2)) continue;
    if (opts.groupIds && !opts.groupIds.includes(s.group_id)) continue;
    if (opts.activeOnly && !s.active) continue;
    const rows = JSON.parse(s.snapshot_json) as SnapRow[];
    if (!labels.has(s.group_id)) labels.set(s.group_id, new Map());
    const lab = labels.get(s.group_id)!;
    for (const r of rows) {
      if (!lab.has(r.author_id)) lab.set(r.author_id, `C${lab.size + 1}`);
      out.push({
        id: r.public_id,
        group_code: r.group_code,
        group_name: r.group_name,
        part: r.part,
        contributor: lab.get(r.author_id)!,
        observation: r.observation,
        timestamp_sec: r.timestamp_sec,
        evidence: r.evidence,
        interpretation: r.interpretation,
        question: r.question,
        responding_to: r.guiding_question_id ? (questions.get(r.guiding_question_id) ?? "") : "",
      });
    }
  }
  return out;
}

export const ts = (e: EntrySnap): string => formatTimestamp(e.timestamp_sec);
