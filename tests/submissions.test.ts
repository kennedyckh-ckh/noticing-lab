/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../lib/db";
import { addFullEntry, api, makeWorld, submit, type World } from "./helpers";

let w: World;
beforeAll(async () => {
  w = await makeWorld("sub", { joinAll: true });
});

describe("separate entries, contributors and autosave", () => {
  it("records the contributor and lets teammates read but not edit each other's entries", async () => {
    const e1 = await addFullEntry(w.tokens.a1, w.groups.g1, 1, "A1", { timestamp: "1:30" });
    const e2 = await addFullEntry(w.tokens.a2, w.groups.g1, 1, "A2");
    expect(e1.author.id).toBe(w.userIds.a1);
    expect(e1.timestamp_sec).toBe(90);
    expect(e1.public_id).toBe("G1-P1-01");
    expect(e2.public_id).toBe("G1-P1-02");
    const ws = await api(w.tokens.a2, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.body.part1.entries.map((e: any) => e.author.id)).toEqual([w.userIds.a1, w.userIds.a2]);
    expect(ws.body.part1.entries[0].mine).toBe(false);
    const edit = await api(w.tokens.a2, "PATCH", `/api/entries/${e1.id}`, { base_version: e1.version, observation: "overwrite attempt" });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("NOT_AUTHOR");
    expect((await api(w.tokens.a2, "DELETE", `/api/entries/${e1.id}`)).status).toBe(403);
    const again = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(again.body.part1.entries[0].observation).toBe("A1 observation");
  });

  it("autosaves partial changes without touching other fields and bumps the version", async () => {
    const e = await addFullEntry(w.tokens.a1, w.groups.g1, 1, "auto");
    const r = await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, interpretation: "changed" });
    expect(r.status).toBe(200);
    expect(r.body.entry.interpretation).toBe("changed");
    expect(r.body.entry.observation).toBe("auto observation");
    expect(r.body.entry.version).toBe(e.version + 1);
    const same = await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: r.body.entry.version, interpretation: "changed" });
    expect(same.body.entry.version).toBe(r.body.entry.version); // no-op does not bump
  });

  it("detects a stale save (two tabs) instead of silently overwriting", async () => {
    const e = await addFullEntry(w.tokens.a1, w.groups.g1, 1, "conflict");
    await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, observation: "tab one" });
    const stale = await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, observation: "tab two" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.body.part1.entries.find((x: any) => x.id === e.id).observation).toBe("tab one");
  });

  it("validates timestamps and field lengths", async () => {
    const bad = await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1, timestamp: "banana" });
    expect(bad.status).toBe(400);
    const long = await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1, observation: "x".repeat(3001) });
    expect(long.status).toBe(400);
    const none = await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1, timestamp: "" });
    expect(none.body.entry.timestamp_sec).toBeNull();
    expect((await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 3 })).status).toBe(400);
  });
});

describe("Part 1 collective submission", () => {
  it("refuses a submit built on a stale view of the group's entries", async () => {
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    await addFullEntry(w.tokens.a2, w.groups.g1, 1, "late-teammate");
    const r = await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/submit`, { part: 1, digest: ws.body.part1.digest });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("DIGEST_MISMATCH");
  });

  it("lists incomplete entries instead of submitting them", async () => {
    const draft = await api(w.tokens.a2, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1, observation: "only an observation" });
    const r = await submit(w.tokens.a1, w.groups.g1, 1);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INCOMPLETE_ENTRIES");
    expect(r.body.incomplete.map((x: any) => x.id)).toContain(draft.body.entry.id);
    // not submitted: still editable
    const fix = await api(w.tokens.a2, "PATCH", `/api/entries/${draft.body.entry.id}`, {
      base_version: draft.body.entry.version,
      evidence: "e",
      interpretation: "i",
    });
    expect(fix.status).toBe(200);
  });

  it("submits for the whole group, snapshots the entries, discards blank drafts, and locks Part 1", async () => {
    await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1 }); // blank draft
    // earlier tests left a few entries: complete or remove any partial ones first
    const ws0 = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    for (const e of ws0.body.part1.entries) {
      if (e.mine && (!e.evidence || !e.interpretation) && (e.observation || e.evidence || e.interpretation)) {
        await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, observation: e.observation || "o", evidence: e.evidence || "e", interpretation: e.interpretation || "i" });
      }
    }
    const r = await submit(w.tokens.a2, w.groups.g1, 1); // either member may submit
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const snap = getDb().prepare("SELECT snapshot_json, submitted_by FROM group_submissions WHERE group_id = ? AND part = 1").get(w.groups.g1) as any;
    expect(snap.submitted_by).toBe(w.userIds.a2);
    const rows = JSON.parse(snap.snapshot_json);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((x: any) => x.observation && x.stage_label.startsWith("Part 1"))).toBe(true);
    expect(rows.every((x: any) => x.author_id && x.created_at)).toBe(true);
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.body.part1.status).toBe("submitted");
    expect(ws.body.part1.submitted_by).toBe("P a2");
    expect(ws.body.part1.entries.every((e: any) => e.locked)).toBe(true);
  });

  it("rejects every write to a submitted part (edit, add, delete, resubmit)", async () => {
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    const mine = ws.body.part1.entries.find((e: any) => e.mine);
    const patch = await api(w.tokens.a1, "PATCH", `/api/entries/${mine.id}`, { base_version: mine.version, observation: "after the fact" });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("PART_SUBMITTED");
    expect((await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 1 })).status).toBe(409);
    expect((await api(w.tokens.a1, "DELETE", `/api/entries/${mine.id}`)).status).toBe(409);
    expect((await submit(w.tokens.a1, w.groups.g1, 1)).status).toBe(409);
  });
});

describe("Part 2: locked until released, and kept apart from Part 1", () => {
  it("is locked on the server and hides the guiding questions before release", async () => {
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.body.part2.locked).toBe(true);
    expect(ws.body.guiding_questions).toEqual([]);
    expect(JSON.stringify(ws.body)).not.toContain("GQ-ONE-sub");
    const add = await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/entries`, { part: 2 });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe("PART2_LOCKED");
    expect((await api(w.tokens.a1, "POST", `/api/groups/${w.groups.g1}/submit`, { part: 2, digest: "x" })).status).toBe(403);
  });

  it("after release shows guiding questions; Part 2 needs Part 1 submitted first", async () => {
    // group 2 has not submitted Part 1; release Part 2 with an override
    const un = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {});
    expect(un.status).toBe(409);
    expect(un.body.code).toBe("MISSING_SUBMISSIONS");
    const ok = await api(w.tokens.fac, "POST", `/api/facilitator/sessions/${w.sid}/unlock-part2`, {
      override: { reason: "Groups 2 and 3 are absent today", confirm: "OVERRIDE" },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const ws = await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`);
    expect(ws.body.part2.locked).toBe(false);
    expect(ws.body.guiding_questions.map((q: any) => q.text)).toEqual(["GQ-ONE-sub", "GQ-TWO-sub"]);
    const blocked = await api(w.tokens.b1, "POST", `/api/groups/${w.groups.g2}/entries`, { part: 2 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("PART1_NOT_SUBMITTED");
  });

  it("stores Part 2 entries separately and never changes the submitted Part 1 record", async () => {
    const before = JSON.stringify((await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`)).body.part1);
    const snapBefore = (getDb().prepare("SELECT snapshot_json FROM group_submissions WHERE group_id = ? AND part = 1").get(w.groups.g1) as any).snapshot_json;
    const e = await addFullEntry(w.tokens.a1, w.groups.g1, 2, "p2", { guiding_question_id: w.questions[0] });
    expect(e.public_id).toBe("G1-P2-01");
    expect(e.stage_label).toBe("Part 2 - Guided noticing");
    expect(e.guiding_question_id).toBe(w.questions[0]);
    await api(w.tokens.a1, "PATCH", `/api/entries/${e.id}`, { base_version: e.version, observation: "part two edit" });
    const r = await submit(w.tokens.a2, w.groups.g1, 2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = JSON.stringify((await api(w.tokens.a1, "GET", `/api/groups/${w.groups.g1}/workspace`)).body.part1);
    expect(after).toBe(before);
    const snapAfter = (getDb().prepare("SELECT snapshot_json FROM group_submissions WHERE group_id = ? AND part = 1").get(w.groups.g1) as any).snapshot_json;
    expect(snapAfter).toBe(snapBefore);
    const p2 = getDb().prepare("SELECT COUNT(*) AS n FROM entries WHERE group_id = ? AND part = 2").get(w.groups.g1) as any;
    expect(p2.n).toBe(1);
  });

  it("rejects a guiding question from another session, and guiding questions on Part 1 entries", async () => {
    const other = await makeWorld("sub-other");
    const w2 = await makeWorld("sub2", { joinAll: true });
    await addFullEntry(w2.tokens.a1, w2.groups.g1, 1, "x");
    expect((await submit(w2.tokens.a1, w2.groups.g1, 1)).status).toBe(200);
    const un = await api(w2.tokens.fac, "POST", `/api/facilitator/sessions/${w2.sid}/unlock-part2`, {
      override: { reason: "others absent", confirm: "OVERRIDE" },
    });
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    const foreign = await api(w2.tokens.a1, "POST", `/api/groups/${w2.groups.g1}/entries`, { part: 2, guiding_question_id: other.questions[0] });
    expect(foreign.status).toBe(400);
    const own = await api(w2.tokens.a1, "POST", `/api/groups/${w2.groups.g1}/entries`, { part: 2, guiding_question_id: w2.questions[1] });
    expect(own.status).toBe(200);
    const part1q = await api(w2.tokens.b1, "POST", `/api/groups/${w2.groups.g2}/entries`, { part: 1, guiding_question_id: w2.questions[0] });
    expect(part1q.status).toBe(400);
  });
});
