/**
 * End-to-end check against a RUNNING server over real HTTP (cookies, CSRF headers included).
 * Uses the demo data from scripts/seed.ts on a fresh database.
 *   BASE=http://localhost:3000 npx tsx scripts/e2e-http.ts
 */
const BASE = process.env.BASE || "http://localhost:3000";
const PW = "demo-pass-123";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
  if (!ok) failures++;
};

class Client {
  cookie = "";
  constructor(public label: string) {}
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), origin: BASE },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  async login(user: string) {
    const r = await this.call("POST", "/api/auth/login", { email: `${user}@example.org`, password: PW });
    if (r.status !== 200) throw new Error(`login ${user} failed ${r.status}`);
  }
}

async function main() {
  const fac = new Client("fac");
  await fac.login("facilitator");
  const sessions = (await fac.call("GET", "/api/facilitator/sessions")).json.sessions;
  const sid: string = sessions[0].id;
  const detail = (await fac.call("GET", `/api/facilitator/sessions/${sid}`)).json;
  const [G1, G2, G3] = detail.groups.map((g: any) => g.id as string);

  const users: Record<string, { c: Client; g: string }> = {};
  const plan: Array<[string, string]> = [["alex", G1], ["bao", G1], ["chen", G2], ["dev", G2], ["eli", G3], ["fay", G3]];
  for (const [u, g] of plan) {
    const c = new Client(u);
    await c.login(u);
    const j = await c.call("POST", "/api/sessions/join", { code: "DEMO42" });
    const s = await c.call("POST", `/api/sessions/${sid}/group`, { group_id: g });
    if (j.status !== 200 || s.status !== 200) throw new Error(`setup failed for ${u}: ${j.status} ${s.status}`);
    users[u] = { c, g };
  }
  check("6 teachers joined and chose their authorised groups over HTTP", true);

  // isolation over real HTTP
  check("a teacher cannot open another group's workspace (404)", (await users.chen.c.call("GET", `/api/groups/${G1}/workspace`)).status === 404);
  check("a teacher cannot call facilitator routes (403)", (await users.alex.c.call("GET", "/api/facilitator/sessions")).status === 403);
  check("anonymous requests are refused (401)", (await new Client("anon").call("GET", `/api/groups/${G1}/workspace`)).status === 401);
  const evil = await fetch(BASE + "/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  check("cross-site POST is blocked (403)", evil.status === 403);
  check("session cookie is HttpOnly + SameSite", (await (async () => { const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: "alex@example.org", password: PW }) }); const c = r.headers.get("set-cookie") || ""; return /HttpOnly/i.test(c) && /SameSite=lax/i.test(c); })()));

  // Part 1: separate entries per member
  const mk = (txt: string, ts: string, interp: string, q = "") => ({ part: 1, observation: `${txt} observation`, timestamp: ts, evidence: `${txt} evidence`, interpretation: interp, question: q });
  await users.alex.c.call("POST", `/api/groups/${G1}/entries`, mk("WAIT pause", "3:40", "The pause gave students room to think.", "Was it planned?"));
  await users.bao.c.call("POST", `/api/groups/${G1}/entries`, mk("WAIT silence", "3:45", "The silence felt uncomfortable for students."));
  await users.chen.c.call("POST", `/api/groups/${G2}/entries`, mk("NUMBERLINE use", "6:05", "Number lines support magnitude thinking."));
  await users.dev.c.call("POST", `/api/groups/${G2}/entries`, mk("CORRECTION fast", "6:30", "A quick correction may have cut off a misconception."));
  const wsA = (await users.alex.c.call("GET", `/api/groups/${G1}/workspace`)).json;
  check("teammates both see 2 entries, authors recorded", wsA.part1.entries.length === 2 && new Set(wsA.part1.entries.map((e: any) => e.author.id)).size === 2);
  const bao = wsA.part1.entries.find((e: any) => !e.mine);
  const steal = await users.alex.c.call("PATCH", `/api/entries/${bao.id}`, { base_version: bao.version, observation: "overwrite" });
  check("a teammate cannot overwrite another member's entry (403)", steal.status === 403);

  for (const [u, g] of [["alex", G1], ["chen", G2]] as const) {
    const ws = (await users[u].c.call("GET", `/api/groups/${g}/workspace`)).json;
    const r = await users[u].c.call("POST", `/api/groups/${g}/submit`, { part: 1, digest: ws.part1.digest });
    check(`${u}'s group submitted Part 1`, r.status === 200, r.text);
  }
  const dash1 = (await fac.call("GET", `/api/facilitator/sessions/${sid}/dashboard`)).json;
  check("dashboard: 2 of 3 active groups submitted", dash1.progress.part1.submitted === 2 && dash1.progress.part1.active === 3);

  // Part 2 stays locked, then the deliberate override
  const locked = await users.alex.c.call("POST", `/api/groups/${G1}/entries`, { part: 2 });
  check("Part 2 refused while locked (403)", locked.status === 403 && locked.json.code === "PART2_LOCKED");
  check("guiding questions not in the workspace while locked", !JSON.stringify(wsA).includes("representations"));
  const noOverride = await fac.call("POST", `/api/facilitator/sessions/${sid}/unlock-part2`, {});
  check("unlock refused without override (409, names missing group)", noOverride.status === 409 && /Group 3/.test(noOverride.json.error));
  const unlock = await fac.call("POST", `/api/facilitator/sessions/${sid}/unlock-part2`, { override: { reason: "Group 3 is still on break", confirm: "OVERRIDE" } });
  check("unlock with deliberate override", unlock.status === 200, unlock.text);
  const wsA2 = (await users.alex.c.call("GET", `/api/groups/${G1}/workspace`)).json;
  check("guiding questions now delivered", wsA2.guiding_questions.length === 3);
  const p1Before = JSON.stringify(wsA2.part1);
  const q0 = wsA2.guiding_questions[0].id;
  const e2 = await users.alex.c.call("POST", `/api/groups/${G1}/entries`, { part: 2, observation: "P2 observation", evidence: "P2 evidence", interpretation: "P2 interpretation", guiding_question_id: q0 });
  check("Part 2 entry created", e2.status === 200 && e2.json.entry.public_id === "G1-P2-01");
  const ws3 = (await users.alex.c.call("GET", `/api/groups/${G1}/workspace`)).json;
  check("Part 1 record unchanged by Part 2 work", JSON.stringify(ws3.part1) === p1Before);
  check("group 3 (no Part 1) cannot start Part 2 (409)", (await users.eli.c.call("POST", `/api/groups/${G3}/entries`, { part: 2 })).status === 409);

  // sharing
  const g2Entries = (await fac.call("GET", `/api/facilitator/sessions/${sid}/groups/${G2}/entries`)).json.entries;
  check("eli (group 3) sees nothing from group 2 before sharing", !JSON.stringify((await users.eli.c.call("GET", `/api/sessions/${sid}/shared`)).json).includes("NUMBERLINE"));
  const sh = await fac.call("POST", `/api/facilitator/entries/${g2Entries[0].id}/share`, { shared: true });
  const seen = (await users.eli.c.call("GET", `/api/sessions/${sid}/shared`)).json;
  check("after sharing, eli sees exactly that entry, author hidden", sh.status === 200 && seen.entries.length === 1 && seen.entries[0].author_name === null && !JSON.stringify(seen).includes("Chen"));

  // AI (simulated) review and publish
  const gen = await fac.call("POST", `/api/facilitator/sessions/${sid}/ai/generate`, { kind: "group_summary", group_id: G1, part: 1 });
  check("group summary draft generated (simulated)", gen.status === 200 && gen.json.simulated === true, gen.text.slice(0, 200));
  check("draft invisible to participants (eli and alex)", !JSON.stringify((await users.eli.c.call("GET", `/api/sessions/${sid}/shared`)).json).includes("WAIT pause") && !JSON.stringify((await users.alex.c.call("GET", `/api/sessions/${sid}/shared`)).json.published_summaries).includes("WAIT"));
  const early = await fac.call("POST", `/api/facilitator/sessions/${sid}/ai/publish-summaries`, {});
  check("publishing an unreviewed draft is refused", early.status === 409);
  await fac.call("POST", `/api/facilitator/ai/${gen.json.id}/review`, {});
  const pub = await fac.call("POST", `/api/facilitator/sessions/${sid}/ai/publish-summaries`, {});
  const after = (await users.eli.c.call("GET", `/api/sessions/${sid}/shared`)).json;
  check("after publish, eli sees the summary; salient points still hidden", pub.status === 200 && after.published_summaries.length === 1 && after.published_salient.length === 0);
  const cg = await fac.call("POST", `/api/facilitator/sessions/${sid}/ai/generate`, { kind: "cross_group", part: 1 });
  check("cross-group needs override record: runs because Part 1 override covers Group 3", cg.status === 200, cg.text.slice(0, 200));

  const ex = await fac.call("GET", `/api/facilitator/sessions/${sid}/export?format=json`);
  const data = JSON.parse(ex.text);
  check("export: entries with stage labels + timestamps, guiding questions, AI outputs, overrides", data.entries.some((e: any) => e.stage_label.startsWith("Part 2") && e.guiding_question_text) && data.entries.some((e: any) => e.timestamp === "3:40") && data.questions.length === 3 && data.ai.length === 2 && data.overrides.length === 1);
  check("export is a download with a filename", /attachment; filename=/.test(ex.headers.get("content-disposition") || ""));
  const csv = await fac.call("GET", `/api/facilitator/sessions/${sid}/export?format=csv`);
  check("CSV export works", csv.text.includes("stage_label") && csv.text.includes("WAIT pause observation"));

  console.log(failures === 0 ? "\nALL END-TO-END CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(2);
});
