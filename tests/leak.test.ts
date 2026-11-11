/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../lib/db";
import { routes } from "../lib/router";
import { addFullEntry, api, makeWorld, submit, type World } from "./helpers";

let w: World;
let foreign: World;
const MARKER_SUBMITTED = "SECRET-SUBMITTED-MARKER-7731";
const MARKER_DRAFT = "SECRET-DRAFT-MARKER-4410";
const MARKER_AI = "SECRET-AI-DRAFT-MARKER-9902";

beforeAll(async () => {
  w = await makeWorld("leak", { joinAll: true });
  foreign = await makeWorld("leak-foreign", { joinAll: true });
  // group 2 holds secrets: a submitted entry, a draft Part 2... and an unpublished AI draft
  await addFullEntry(w.tokens.b1, w.groups.g2, 1, MARKER_SUBMITTED);
  expect((await submit(w.tokens.b1, w.groups.g2, 1)).status).toBe(200);
  const un = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {
    override: { reason: "testing leak paths", confirm: "OVERRIDE" },
  });
  expect(un.status, JSON.stringify(un.body)).toBe(200);
  await addFullEntry(w.tokens.b1, w.groups.g2, 2, MARKER_DRAFT);
  getDb()
    .prepare(
      `INSERT INTO ai_outputs (id, session_id, kind, group_id, part, status, provider, model, simulated, criteria, generated_json, edited_json, source_entry_ids_json, created_at, created_by, updated_at)
       VALUES ('ai-draft-1', ?, 'group_summary', ?, '1', 'draft', 'simulated', 'sim', 1, '', ?, ?, '[]', ?, ?, ?)`,
    )
    .run(w.sid, w.groups.g2, JSON.stringify({ note: MARKER_AI }), JSON.stringify({ note: MARKER_AI }), new Date().toISOString(), w.fac.id, new Date().toISOString());
  getDb()
    .prepare(
      `INSERT INTO ai_outputs (id, session_id, kind, part, status, provider, model, simulated, criteria, generated_json, source_entry_ids_json, created_at, created_by, updated_at)
       VALUES ('ai-cross-1', ?, 'cross_group', '1', 'published', 'simulated', 'sim', 1, '', ?, '[]', ?, ?, ?)`,
    )
    .run(w.sid, JSON.stringify({ note: MARKER_AI }), new Date().toISOString(), w.fac.id, new Date().toISOString());
});

// every GET a participant could call, with ids filled in
function participantGets(world: World): string[] {
  return [
    `/api/my/sessions`,
    `/api/sessions/${world.sid}/overview`,
    `/api/sessions/${world.sid}/shared`,
    `/api/groups/${world.groups.g1}/workspace`,
    `/api/groups/${world.groups.g2}/workspace`,
    `/api/groups/${world.groups.g3}/workspace`,
    `/api/sessions/${w.sid}/overview`,
    `/api/sessions/${w.sid}/shared`,
    `/api/groups/${w.groups.g1}/workspace`,
    `/api/groups/${w.groups.g2}/workspace`,
    `/api/groups/${w.groups.g3}/workspace`,
  ];
}

describe("before publication, other groups' content never reaches a participant", () => {
  const markers = [MARKER_SUBMITTED, MARKER_DRAFT, MARKER_AI];

  it("group 1 members, group 3 members, outsiders and another session's members never receive group 2's content", async () => {
    const viewers: Array<[string, string]> = [
      ["a1 (other group, same session)", w.tokens.a1],
      ["a2 (other group, same session)", w.tokens.a2],
      ["c1 (other group, same session)", w.tokens.c1],
      ["outsider (not on roster)", w.tokens.outsider],
      ["foreign session member", foreign.tokens.a1],
      ["foreign group member", foreign.tokens.b2],
    ];
    let checked = 0;
    for (const [label, token] of viewers) {
      for (const path of participantGets(foreign)) {
        const r = await api(token, "GET", path);
        const text = JSON.stringify(r.body);
        for (const m of markers) expect(text, `${label} GET ${path}`).not.toContain(m);
        checked++;
      }
    }
    expect(checked).toBe(viewers.length * 11);
  });

  it("does not expose the other group's entry ids or authors through the entry endpoints", async () => {
    const g2 = (await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/groups/${w.groups.g2}/entries`)).body.entries;
    for (const e of g2) {
      expect((await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, observation: "x" })).status).toBe(404);
      expect((await api(w.tokens.a1, "DELETE", `/api/entries/${e.id}`)).status).toBe(404);
      expect((await api(w.tokens.outsider, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, observation: "x" })).status).toBe(404);
    }
  });

  it("group 2's own members do see their own content (so the test above is meaningful)", async () => {
    const r = await api(w.tokens.b2, "GET", `/api/groups/${w.groups.g2}/workspace`);
    expect(JSON.stringify(r.body)).toContain(MARKER_SUBMITTED);
    expect(JSON.stringify(r.body)).toContain(MARKER_DRAFT);
    expect(JSON.stringify(r.body)).not.toContain(MARKER_AI); // not even their own group sees unpublished AI drafts
  });

  it("never publishes the cross-group comparison to participants, even if its status were 'published'", async () => {
    const r = await api(w.tokens.a1, "GET", `/api/sessions/${w.sid}/shared`);
    expect(JSON.stringify(r.body)).not.toContain(MARKER_AI);
  });
});

describe("role and authentication sweep over every route", () => {
  const fill = (p: string) => p.replace(/:\w+/g, "x");

  it("every protected route rejects anonymous callers", async () => {
    let n = 0;
    for (const r of routes.filter((x) => x.auth !== "none")) {
      const res = await api(null, r.method, fill(r.pattern), r.method === "GET" ? undefined : {});
      expect(res.status, `${r.method} ${r.pattern}`).toBe(401);
      n++;
    }
    expect(n).toBeGreaterThan(30);
  });

  it("facilitator routes reject participants; participant routes reject facilitators", async () => {
    for (const r of routes) {
      const body = r.method === "GET" ? undefined : {};
      if (r.auth === "facilitator") {
        const res = await api(w.tokens.a1, r.method, fill(r.pattern), body);
        expect(res.status, `participant on ${r.method} ${r.pattern}`).toBe(403);
      }
      if (r.auth === "participant") {
        const res = await api(w.tokens.fac, r.method, fill(r.pattern), body);
        expect(res.status, `facilitator on ${r.method} ${r.pattern}`).toBe(403);
      }
    }
  });
});
