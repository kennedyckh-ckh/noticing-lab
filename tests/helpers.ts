/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from "../lib/db";
import { createUser, hashPassword, resetThrottle } from "../lib/auth";
import { addQuestion, createParticipants, createSession, sessionDetail } from "../lib/facilitator";
import { dispatch } from "../lib/router";
import type { User } from "../lib/types";

export const PW = "correct-horse-9";

export async function api(token: string | null, method: string, path: string, body?: unknown, query?: Record<string, string>) {
  const r = await dispatch({ method, path, token, body, query, ip: "test", origin: null, host: null });
  return { status: r.status, body: r.body as any, raw: r.raw, cookie: r.cookie };
}

export async function loginAs(email: string, password = PW): Promise<string> {
  const r = await api(null, "POST", "/api/auth/login", { email, password });
  if (r.status !== 200 || !r.cookie?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.cookie.token;
}

export function setKnownPassword(userId: string): void {
  getDb().prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(PW), userId);
}

export interface World {
  fac: User;
  sid: string;
  code: string;
  groups: { g1: string; g2: string; g3: string };
  questions: string[];
  emails: Record<"a1" | "a2" | "b1" | "b2" | "c1" | "outsider", string>;
  userIds: Record<string, string>;
  tokens: Record<string, string>;
}

/** A facilitator, a session with 3 groups and 2 guiding questions, and participants. Unique per tag. */
export async function makeWorld(tag: string, opts: { joinAll?: boolean } = {}): Promise<World> {
  resetThrottle();
  const fac = createUser({ email: `${tag}-fac@t.org`, name: `Fac ${tag}`, password: PW, role: "facilitator" });
  const { id: sid } = createSession(fac, { title: `Session ${tag}`, num_groups: 3 });
  const detail = sessionDetail(fac, sid);
  const [g1, g2, g3] = detail.groups.map((g) => g.id);
  const questions = [addQuestion(fac, sid, { text: `GQ-ONE-${tag}` }).id, addQuestion(fac, sid, { text: `GQ-TWO-${tag}` }).id];
  const emails = {
    a1: `${tag}-a1@t.org`,
    a2: `${tag}-a2@t.org`,
    b1: `${tag}-b1@t.org`,
    b2: `${tag}-b2@t.org`,
    c1: `${tag}-c1@t.org`,
    outsider: `${tag}-out@t.org`,
  };
  const place: Array<[keyof typeof emails, string | null]> = [
    ["a1", g1],
    ["a2", g1],
    ["b1", g2],
    ["b2", g2],
    ["c1", g3],
    ["outsider", null],
  ];
  const userIds: Record<string, string> = {};
  for (const [k, g] of place) {
    if (g) {
      const res = createParticipants(fac, sid, { people: [{ name: `P ${k}`, email: emails[k] }], group_id: g }).results[0];
      userIds[k] = res.user_id as string;
    } else {
      userIds[k] = createUser({ email: emails[k], name: `P ${k}`, password: PW, role: "participant" }).id;
    }
    setKnownPassword(userIds[k]);
  }
  const code = (getDb().prepare("SELECT join_code FROM pd_sessions WHERE id = ?").get(sid) as { join_code: string }).join_code;
  const tokens: Record<string, string> = { fac: await loginAs(`${tag}-fac@t.org`) };
  for (const k of Object.keys(emails) as Array<keyof typeof emails>) tokens[k] = await loginAs(emails[k]);
  const w: World = { fac, sid, code, groups: { g1, g2, g3 }, questions, emails, userIds, tokens };
  if (opts.joinAll) {
    const groupOf: Record<string, string> = { a1: g1, a2: g1, b1: g2, b2: g2, c1: g3 };
    for (const k of Object.keys(groupOf)) {
      await api(tokens[k], "POST", "/api/sessions/join", { code });
      await api(tokens[k], "POST", `/api/sessions/${sid}/group`, { group_id: groupOf[k] });
    }
  }
  return w;
}

export async function addFullEntry(token: string, groupId: string, part: 1 | 2, text: string, extra: Record<string, unknown> = {}) {
  const r = await api(token, "POST", `/api/groups/${groupId}/entries`, {
    part,
    observation: `${text} observation`,
    evidence: `${text} evidence`,
    interpretation: `${text} interpretation`,
    ...extra,
  });
  if (r.status !== 200) throw new Error(`addFullEntry failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.entry as any;
}

export async function submit(token: string, groupId: string, part: 1 | 2) {
  const ws = await api(token, "GET", `/api/groups/${groupId}/workspace`);
  const digest = part === 1 ? ws.body.part1.digest : ws.body.part2.digest;
  return api(token, "POST", `/api/groups/${groupId}/submit`, { part, digest });
}
