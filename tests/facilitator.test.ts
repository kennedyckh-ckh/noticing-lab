/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../lib/db";
import { stageGate } from "../lib/facilitator";
import { addFullEntry, api, makeWorld, submit, type World } from "./helpers";

let w: World;
const dash = async () => (await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/dashboard`)).body;
const grp = (d: any, id: string) => d.groups.find((g: any) => g.id === id);

beforeAll(async () => {
  w = await makeWorld("fac", { joinAll: true });
});

describe("dashboard status for both parts", () => {
  it("starts empty with Part 2 locked", async () => {
    const d = await dash();
    expect(grp(d, w.groups.g1).part1.status).toBe("not_started");
    expect(grp(d, w.groups.g1).part2.status).toBe("locked");
    expect(d.progress.part1).toMatchObject({ active: 3, submitted: 0 });
  });

  it("shows draft, then submitted, per group", async () => {
    await addFullEntry(w.tokens.a1, w.groups.g1, 1, "d1");
    await addFullEntry(w.tokens.a2, w.groups.g1, 1, "d2");
    let d = await dash();
    expect(grp(d, w.groups.g1).part1).toMatchObject({ status: "draft", entry_count: 2, contributors: 2 });
    expect((await submit(w.tokens.a1, w.groups.g1, 1)).status).toBe(200);
    d = await dash();
    expect(grp(d, w.groups.g1).part1.status).toBe("submitted");
    expect(grp(d, w.groups.g1).part1.submitted_by).toBe("P a1");
    expect(d.progress.part1).toMatchObject({ active: 3, submitted: 1 });
    expect(d.progress.part1.missing.map((m: any) => m.id).sort()).toEqual([w.groups.g2, w.groups.g3].sort());
  });

  it("lets the facilitator read every group's contributions, including drafts", async () => {
    await addFullEntry(w.tokens.b1, w.groups.g2, 1, "b-draft");
    const r = await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/groups/${w.groups.g2}/entries`);
    expect(r.status).toBe(200);
    expect(r.body.entries[0].observation).toBe("b-draft observation");
    expect(r.body.entries[0].submitted).toBe(false);
    expect(r.body.entries[0].author.name).toBe("P b1");
  });
});

describe("unlocking Part 2 and the missing-group override", () => {
  it("will not unlock while active groups are missing, and says which", async () => {
    const r = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("MISSING_SUBMISSIONS");
    expect(r.body.counts).toMatchObject({ active: 3, submitted: 1 });
    expect(r.body.error).toContain("1 of 3");
    expect((await dash()).session.part2_unlocked_at).toBeNull();
  });

  it("requires a reason and the typed confirmation for an override", async () => {
    const url = `/api/facilitator/sessions/${w.sid}/unlock-part2`;
    expect((await api(w.tokens.fac, "POST", url, { override: { reason: "absent", confirm: "yes" } })).status).toBe(400);
    expect((await api(w.tokens.fac, "POST", url, { override: { reason: "no", confirm: "OVERRIDE" } })).status).toBe(400);
    expect((await dash()).session.part2_unlocked_at).toBeNull();
  });

  it("ignores inactive groups when counting", async () => {
    await api(w.tokens.fac, "PATCH", `/api/facilitator/groups/${w.groups.g3}`, { active: false });
    const d = await dash();
    expect(d.progress.part1).toMatchObject({ active: 2, submitted: 1 });
    await api(w.tokens.fac, "PATCH", `/api/facilitator/groups/${w.groups.g3}`, { active: true });
  });

  it("does not unlock without guiding questions", async () => {
    const empty = await makeWorld("fac-noq");
    getDb().prepare("DELETE FROM guiding_questions WHERE session_id = ?").run(empty.sid);
    const r = await api(empty.tokens.fac, "POST", `/api/facilitator/sessions/${empty.sid}/unlock-part2`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NO_GUIDING_QUESTIONS");
  });

  it("an override is recorded with a reason and covers only the groups that were missing at the time", async () => {
    const o = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/override`, { part: 1, reason: "Groups 2 and 3 left early", confirm: "OVERRIDE" });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.missing).toHaveLength(2);
    expect(stageGate(w.sid, 1).ok).toBe(true);
    // a brand-new group makes the earlier override insufficient
    const g = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/groups`, { name: "Late group" });
    expect(g.status).toBe(200);
    expect(stageGate(w.sid, 1).ok).toBe(false);
    await api(w.tokens.fac, "PATCH", `/api/facilitator/groups/${g.body.id}`, { active: false });
    expect(stageGate(w.sid, 1).ok).toBe(true);
  });

  it("unlocks once a deliberate override covers the missing groups, records it, and is idempotent", async () => {
    // the override recorded above (with reason and typed confirmation) covers exactly these missing groups
    const ok = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.already_unlocked).toBe(false);
    expect((await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {})).body.already_unlocked).toBe(true);
    const d = await dash();
    expect(d.session.part2_unlocked_at).toBeTruthy();
    expect(d.overrides.length).toBeGreaterThanOrEqual(1);
    const log = getDb().prepare("SELECT detail_json FROM audit_log WHERE session_id = ? AND action = 'part2_unlocked'").all(w.sid) as any[];
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].detail_json).override_id).toBeTruthy();
    expect(grp(d, w.groups.g1).part2.status).toBe("not_started");
  });

  it("can also unlock with the override confirmed in the same request", async () => {
    const x = await makeWorld("fac-inline", { joinAll: true });
    await addFullEntry(x.tokens.a1, x.groups.g1, 1, "i");
    expect((await submit(x.tokens.a1, x.groups.g1, 1)).status).toBe(200);
    const ok = await api(x.tokens.fac, "POST", `/api/facilitator/sessions/${x.sid}/unlock-part2`, {
      override: { reason: "two groups absent", confirm: "OVERRIDE" },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(((await api(x.tokens.fac, "GET", `/api/facilitator/sessions/${x.sid}/dashboard`)).body.overrides)).toHaveLength(1);
  });

  it("refuses an override when nobody is missing", async () => {
    const x = await makeWorld("fac-all", { joinAll: true });
    for (const [k, g] of [["a1", x.groups.g1], ["b1", x.groups.g2], ["c1", x.groups.g3]] as const) {
      await addFullEntry(x.tokens[k], g, 1, k);
      expect((await submit(x.tokens[k], g, 1)).status).toBe(200);
    }
    const o = await api(x.tokens.fac, "POST", `/api/facilitator/sessions/${x.sid}/override`, { part: 1, reason: "not needed", confirm: "OVERRIDE" });
    expect(o.status).toBe(409);
    expect(o.body.code).toBe("NO_OVERRIDE_NEEDED");
    const un = await api(x.tokens.fac, "POST", `/api/facilitator/sessions/${x.sid}/unlock-part2`, {});
    expect(un.status).toBe(200); // all active groups submitted: no override needed
  });
});

describe("controlled sharing of original contributions", () => {
  let sharedEntry: any;
  let draftEntry: any;

  beforeAll(async () => {
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    sharedEntry = ws.body.part1.entries.find((e: any) => e.mine);
    draftEntry = (await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/groups/${w.groups.g2}/entries`)).body.entries[0];
  });

  it("shows other groups nothing until the facilitator shares something", async () => {
    const r = await api(w.tokens.b1, "GET", `/api/sessions/${w.sid}/shared`);
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([]);
  });

  it("only allows sharing entries from a part the group has submitted", async () => {
    const r = await api(w.tokens.fac, "POST", `/api/facilitator/entries/${draftEntry.id}/share`, { shared: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_SUBMITTED");
  });

  it("participants cannot share anything themselves", async () => {
    const r = await api(w.tokens.a1, "POST", `/api/facilitator/entries/${sharedEntry.id}/share`, { shared: true });
    expect(r.status).toBe(403);
  });

  it("shares a selected entry with whitelisted fields and the author hidden by default", async () => {
    expect((await api(w.tokens.fac, "POST", `/api/facilitator/entries/${sharedEntry.id}/share`, { shared: true })).status).toBe(200);
    const r = await api(w.tokens.b1, "GET", `/api/sessions/${w.sid}/shared`);
    expect(r.body.entries).toHaveLength(1);
    const e = r.body.entries[0];
    expect(e.observation).toBe(sharedEntry.observation);
    expect(e.author_name).toBeNull();
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(w.userIds.a1);
    expect(text).not.toContain(w.emails.a1);
    expect(text).not.toContain("P a1");
    // entries of the same group that were NOT selected stay hidden
    expect(r.body.entries.every((x: any) => x.public_id === sharedEntry.public_id)).toBe(true);
  });

  it("can reveal the contributor name when the facilitator chooses", async () => {
    await api(w.tokens.fac, "POST", `/api/facilitator/entries/${sharedEntry.id}/share`, { shared: true, show_author: true });
    const r = await api(w.tokens.b1, "GET", `/api/sessions/${w.sid}/shared`);
    expect(r.body.entries[0].author_name).toBe("P a1");
  });

  it("honours the session-level sharing switch and un-sharing", async () => {
    await api(w.tokens.fac, "PATCH", `/api/facilitator/sessions/${w.sid}`, { sharing_enabled: false });
    expect((await api(w.tokens.b1, "GET", `/api/sessions/${w.sid}/shared`)).body.entries).toEqual([]);
    await api(w.tokens.fac, "PATCH", `/api/facilitator/sessions/${w.sid}`, { sharing_enabled: true });
    expect((await api(w.tokens.b1, "GET", `/api/sessions/${w.sid}/shared`)).body.entries).toHaveLength(1);
    await api(w.tokens.fac, "POST", `/api/facilitator/entries/${sharedEntry.id}/share`, { shared: false });
    expect((await api(w.tokens.b1, "GET", `/api/sessions/${w.sid}/shared`)).body.entries).toEqual([]);
  });
});

describe("export", () => {
  it("exports responses with stage labels, timestamps, contributors and guiding questions (JSON)", async () => {
    await addFullEntry(w.tokens.a1, w.groups.g1, 2, "exp", { timestamp: "2:05", guiding_question_id: w.questions[0] });
    const r = await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/export`, undefined, { format: "json" });
    expect(r.status).toBe(200);
    const data = JSON.parse(r.raw!.text);
    expect(r.raw!.contentType).toContain("json");
    expect(data.questions.map((q: any) => q.text)).toEqual(["GQ-ONE-fac", "GQ-TWO-fac"]);
    const p1 = data.entries.find((e: any) => e.stage_label === "Part 1 - Initial noticing" && e.status === "submitted");
    expect(p1).toBeTruthy();
    expect(p1.created_at && p1.updated_at && p1.submitted_at && p1.author_name).toBeTruthy();
    const p2 = data.entries.find((e: any) => e.entry_id === "G1-P2-01");
    expect(p2).toMatchObject({ stage_label: "Part 2 - Guided noticing", timestamp: "2:05", timestamp_sec: 125, status: "draft", guiding_question_text: "GQ-ONE-fac" });
    expect(data.submissions.length).toBeGreaterThanOrEqual(1);
    expect(data.overrides.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(data)).not.toContain(w.code); // join code is not exported
    expect(Array.isArray(data.ai)).toBe(true);
  });

  it("exports CSV and neutralises spreadsheet formulas", async () => {
    const ws = await api(w.tokens.a2, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.status).toBe(200);
    const e = await api(w.tokens.a2, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 2, observation: '=HYPERLINK("http://evil","x")', evidence: "e", interpretation: "i" });
    expect(e.status).toBe(200);
    const csv = await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/export`, undefined, { format: "csv" });
    expect(csv.raw!.contentType).toContain("text/csv");
    expect(csv.raw!.text).toContain("stage_label");
    expect(csv.raw!.text).toContain(`"'=HYPERLINK(`);
    expect(csv.raw!.text).not.toContain(`,"=HYPERLINK`);
    expect((await api(w.tokens.fac, "GET", `/api/facilitator/sessions/${w.sid}/export`, undefined, { format: "xml" })).status).toBe(400);
  });

  it("is facilitator-only", async () => {
    expect((await api(w.tokens.a1, "GET", `/api/facilitator/sessions/${w.sid}/export`)).status).toBe(403);
    expect((await api(null, "GET", `/api/facilitator/sessions/${w.sid}/export`)).status).toBe(401);
  });
});
