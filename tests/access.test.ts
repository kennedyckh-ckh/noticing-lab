/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { resetThrottle } from "../lib/auth";
import { addFullEntry, api, makeWorld, type World } from "./helpers";

let w: World; // main session
let other: World; // a different facilitator and session

beforeAll(async () => {
  w = await makeWorld("acc");
  other = await makeWorld("acc2");
});

describe("joining a session", () => {
  it("rejects a wrong code, and throttles repeated guessing", async () => {
    resetThrottle();
    const r = await api(w.tokens.a1, "POST", "/api/sessions/join", { code: "ZZZZZZ" });
    expect(r.status).toBe(404);
    for (let i = 0; i < 5; i++) await api(w.tokens.c1, "POST", "/api/sessions/join", { code: "QQQQQQ" });
    const locked = await api(w.tokens.c1, "POST", "/api/sessions/join", { code: w.code });
    expect(locked.status).toBe(429);
    resetThrottle();
  });

  it("refuses a valid code from someone who is not on the roster", async () => {
    const r = await api(w.tokens.outsider, "POST", "/api/sessions/join", { code: w.code });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("NOT_ON_ROSTER");
    expect((await api(w.tokens.outsider, "GET", `/api/sessions/${w.sid}/overview`)).status).toBe(404);
  });

  it("lets a rostered participant join (twice is fine) and lists the session", async () => {
    expect((await api(w.tokens.a1, "POST", "/api/sessions/join", { code: w.code.toLowerCase() })).status).toBe(200);
    expect((await api(w.tokens.a1, "POST", "/api/sessions/join", { code: w.code })).status).toBe(200);
    const mine = await api(w.tokens.a1, "GET", "/api/my/sessions");
    expect(mine.body.sessions).toHaveLength(1);
    expect(mine.body.sessions[0].group).toBeNull();
  });
});

describe("choosing an authorised group", () => {
  beforeAll(async () => {
    for (const k of ["a2", "b1", "b2", "c1"]) await api(w.tokens[k], "POST", "/api/sessions/join", { code: w.code });
  });

  it("shows a participant only the groups they are authorised for", async () => {
    const r = await api(w.tokens.a1, "GET", `/api/sessions/${w.sid}/overview`);
    expect(r.body.authorised_groups.map((g: any) => g.id)).toEqual([w.groups.g1]);
    expect(JSON.stringify(r.body)).not.toContain(w.groups.g2);
  });

  it("refuses an unauthorised group, accepts an authorised one", async () => {
    const bad = await api(w.tokens.a1, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g2 });
    expect(bad.status).toBe(403);
    const ok = await api(w.tokens.a1, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g1 });
    expect(ok.status).toBe(200);
  });

  it("does not let someone open a group workspace they did not choose or are not in", async () => {
    // a2 joined the session and is authorised for g1, but has not chosen it yet
    expect((await api(w.tokens.a2, "GET", `/api/groups/${w.groups.g1}/workspace`)).status).toBe(404);
    // b1 is in the session but belongs to another group
    await api(w.tokens.b1, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g2 });
    expect((await api(w.tokens.b1, "GET", `/api/groups/${w.groups.g1}/workspace`)).status).toBe(404);
    expect((await api(w.tokens.b1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1 })).status).toBe(404);
  });

  it("allows switching only while the participant has written nothing", async () => {
    // c1 is authorised only for g3, so give c1 a second option through the facilitator
    await api(w.tokens.fac, "POST", `/api/facilitator/groups/${w.groups.g2}/authorise`, { user_id: w.userIds.c1 });
    expect((await api(w.tokens.c1, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g3 })).status).toBe(200);
    expect((await api(w.tokens.c1, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g2 })).status).toBe(200); // switch ok, no entries
    await addFullEntry(w.tokens.c1, w.groups.g2, 1, "c1-note");
    const stuck = await api(w.tokens.c1, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g3 });
    expect(stuck.status).toBe(409);
    expect(stuck.body.code).toBe("HAS_ENTRIES");
  });

  it("rejects selecting an inactive group", async () => {
    await api(w.tokens.fac, "PATCH", `/api/facilitator/groups/${w.groups.g3}`, { active: false });
    await api(w.tokens.fac, "POST", `/api/facilitator/groups/${w.groups.g3}/authorise`, { user_id: w.userIds.a2 });
    const r = await api(w.tokens.a2, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g3 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("GROUP_INACTIVE");
    await api(w.tokens.fac, "PATCH", `/api/facilitator/groups/${w.groups.g3}`, { active: true });
  });
});

describe("isolation between sessions and facilitators", () => {
  it("keeps another facilitator out of this session's data and controls", async () => {
    const t = other.tokens.fac;
    const e = await addFullEntry(w.tokens.a1, w.groups.g1, 1, "iso");
    expect((await api(t, "GET", `/api/facilitator/sessions/${w.sid}`)).status).toBe(404);
    expect((await api(t, "GET", `/api/facilitator/sessions/${w.sid}/dashboard`)).status).toBe(404);
    expect((await api(t, "GET", `/api/facilitator/sessions/${w.sid}/groups/${w.groups.g1}/entries`)).status).toBe(404);
    expect((await api(t, "PATCH", `/api/facilitator/sessions/${w.sid}`, { title: "hijack" })).status).toBe(404);
    expect((await api(t, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {})).status).toBe(404);
    expect((await api(t, "POST", `/api/facilitator/entries/${e.id}/share`, { shared: true })).status).toBe(404);
    expect((await api(t, "PATCH", `/api/facilitator/groups/${w.groups.g1}`, { name: "hijack" })).status).toBe(404);
    expect((await api(t, "POST", `/api/facilitator/groups/${w.groups.g1}/authorise`, { user_id: other.userIds.a1 })).status).toBe(404);
    expect((await api(t, "GET", `/api/facilitator/sessions/${w.sid}/export`)).status).toBe(404);
  });

  it("keeps a participant of one session out of another session", async () => {
    const t = other.tokens.a1; // not even joined to any session yet
    expect((await api(t, "GET", `/api/sessions/${w.sid}/overview`)).status).toBe(404);
    expect((await api(t, "GET", `/api/sessions/${w.sid}/shared`)).status).toBe(404);
    expect((await api(t, "GET", `/api/groups/${w.groups.g1}/workspace`)).status).toBe(404);
    await api(t, "POST", "/api/sessions/join", { code: other.code });
    expect((await api(t, "GET", `/api/sessions/${w.sid}/overview`)).status).toBe(404);
    expect((await api(t, "POST", `/api/sessions/${w.sid}/group`, { group_id: w.groups.g1 })).status).toBe(404);
  });

  it("ends access immediately when a facilitator removes someone from a group", async () => {
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.status).toBe(200);
    const entry = ws.body.part1.entries[0];
    await api(w.tokens.fac, "DELETE", `/api/facilitator/groups/${w.groups.g1}/authorise/${w.userIds.a1}`);
    expect((await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`)).status).toBe(404);
    expect((await api(w.tokens.a1, "PATCH", `/api/entries/${entry.id}`, { base_version: entry.version, observation: "x" })).status).toBe(404);
    expect((await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1 })).status).toBe(404);
  });
});
