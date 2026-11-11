/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../lib/db";
import { createUser, resetThrottle } from "../lib/auth";
import { dispatch } from "../lib/router";
import { PW, api, loginAs, makeWorld, type World } from "./helpers";

let w: World;
beforeAll(async () => {
  w = await makeWorld("auth");
});

describe("login and sessions", () => {
  it("logs in, sets a session token, and never returns the password hash", async () => {
    resetThrottle();
    const r = await api(null, "POST", "/api/auth/login", { email: w.emails.a1, password: PW });
    expect(r.status).toBe(200);
    expect(r.cookie?.token).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/password_hash|scrypt/i);
    expect(r.body.user.role).toBe("participant");
  });

  it("stores only a hash of the password and only a hash of the session token", () => {
    const row = getDb().prepare("SELECT password_hash FROM users WHERE email = ?").get(w.emails.a1) as any;
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain(PW);
    const toks = getDb().prepare("SELECT token_hash FROM auth_sessions").all() as any[];
    expect(toks.every((t) => t.token_hash.length === 64)).toBe(true);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    resetThrottle();
    const a = await api(null, "POST", "/api/auth/login", { email: w.emails.a1, password: "nope-nope-1" });
    const b = await api(null, "POST", "/api/auth/login", { email: "nobody@t.org", password: "nope-nope-1" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it("locks after 5 failures, even for the correct password", async () => {
    resetThrottle();
    for (let i = 0; i < 5; i++) await api(null, "POST", "/api/auth/login", { email: w.emails.b2, password: "wrong-pass-1" });
    const r = await api(null, "POST", "/api/auth/login", { email: w.emails.b2, password: PW });
    expect(r.status).toBe(429);
    resetThrottle();
  });

  it("rejects missing, tampered and expired tokens; logout ends the session", async () => {
    expect((await api(null, "GET", "/api/auth/me")).status).toBe(401);
    expect((await api("tampered-token", "GET", "/api/auth/me")).status).toBe(401);
    const t = await loginAs(w.emails.a2);
    expect((await api(t, "GET", "/api/auth/me")).status).toBe(200);
    getDb().prepare("UPDATE auth_sessions SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - 1000).toISOString(), w.userIds.a2);
    expect((await api(t, "GET", "/api/auth/me")).status).toBe(401);
    const t2 = await loginAs(w.emails.a2);
    await api(t2, "POST", "/api/auth/logout");
    expect((await api(t2, "GET", "/api/auth/me")).status).toBe(401);
  });
});

describe("password change and temporary passwords", () => {
  it("changes password, invalidates other sessions, and old password stops working", async () => {
    resetThrottle();
    const u = createUser({ email: "pw@t.org", name: "PW", password: PW, role: "participant" });
    const t1 = await loginAs("pw@t.org");
    const t2 = await loginAs("pw@t.org");
    expect((await api(t1, "POST", "/api/auth/change-password", { current: "wrong-wrong-1", next: "brand-new-pass-1" })).status).toBe(401);
    expect((await api(t1, "POST", "/api/auth/change-password", { current: PW, next: "short" })).status).toBe(400);
    expect((await api(t1, "POST", "/api/auth/change-password", { current: PW, next: "brand-new-pass-1" })).status).toBe(200);
    expect((await api(t2, "GET", "/api/auth/me")).status).toBe(401); // other session ended
    expect((await api(t1, "GET", "/api/auth/me")).status).toBe(200); // this one kept
    resetThrottle();
    expect((await api(null, "POST", "/api/auth/login", { email: "pw@t.org", password: PW })).status).toBe(401);
    expect((await api(null, "POST", "/api/auth/login", { email: "pw@t.org", password: "brand-new-pass-1" })).status).toBe(200);
    expect(u.id).toBeTruthy();
  });

  it("blocks everything except change-password while the password is temporary", async () => {
    resetThrottle();
    createUser({ email: "temp@t.org", name: "Temp", password: PW, role: "participant", mustChange: true });
    const t = await loginAs("temp@t.org");
    const blocked = await api(t, "GET", "/api/my/sessions");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("MUST_CHANGE_PASSWORD");
    expect((await api(t, "GET", "/api/auth/me")).status).toBe(200);
    expect((await api(t, "POST", "/api/auth/change-password", { current: PW, next: "a-fresh-password-1" })).status).toBe(200);
    expect((await api(t, "GET", "/api/my/sessions")).status).toBe(200);
  });
});

describe("roles and request checks", () => {
  it("keeps participants out of facilitator routes and facilitators out of participant routes", async () => {
    expect((await api(w.tokens.a1, "GET", "/api/facilitator/sessions")).status).toBe(403);
    expect((await api(w.tokens.a1, "GET", `/api/facilitator/sessions/${w.sid}/dashboard`)).status).toBe(403);
    expect((await api(w.tokens.fac, "GET", "/api/my/sessions")).status).toBe(403);
    expect((await api(w.tokens.fac, "POST", "/api/sessions/join", { code: w.code })).status).toBe(403);
  });

  it("blocks cross-site writes and non-JSON bodies", async () => {
    const base = { method: "POST", path: "/api/auth/login", body: { email: w.emails.c1, password: PW }, ip: "x" };
    resetThrottle();
    const cross = await dispatch({ ...base, origin: "https://evil.example", host: "pd.example", contentType: "application/json" });
    expect(cross.status).toBe(403);
    const same = await dispatch({ ...base, origin: "https://pd.example", host: "pd.example", contentType: "application/json" });
    expect(same.status).toBe(200);
    const form = await dispatch({ ...base, origin: "https://pd.example", host: "pd.example", contentType: "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    expect((await api(null, "GET", "/api/nope")).status).toBe(404);
    expect((await api(null, "DELETE", "/api/auth/login")).status).toBe(405);
  });
});
