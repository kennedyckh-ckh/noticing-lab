/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { getDb } from "../lib/db";
import { bootstrapFacilitator } from "../lib/bootstrap";
import { dispatch } from "../lib/router";
import { api } from "./helpers";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("first-run facilitator bootstrap", () => {
  it("does nothing without all three variables", () => {
    expect(bootstrapFacilitator(env({}))).toBe("skipped");
    expect(bootstrapFacilitator(env({ BOOTSTRAP_FACILITATOR_EMAIL: "a@b.org" }))).toBe("skipped");
  });
  it("rejects a weak password without crashing", () => {
    expect(bootstrapFacilitator(env({ BOOTSTRAP_FACILITATOR_EMAIL: "weak@b.org", BOOTSTRAP_FACILITATOR_NAME: "W", BOOTSTRAP_FACILITATOR_PASSWORD: "short" }))).toBe("invalid");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });
  it("creates one facilitator who must change the password, and never again", async () => {
    const e = env({ BOOTSTRAP_FACILITATOR_EMAIL: "Boss@School.org", BOOTSTRAP_FACILITATOR_NAME: "Boss", BOOTSTRAP_FACILITATOR_PASSWORD: "a-long-start-pass" });
    expect(bootstrapFacilitator(e)).toBe("created");
    expect(bootstrapFacilitator(e)).toBe("skipped");
    expect(bootstrapFacilitator(env({ ...e, BOOTSTRAP_FACILITATOR_EMAIL: "other@school.org" }))).toBe("skipped");
    const r = await api(null, "POST", "/api/auth/login", { email: "boss@school.org", password: "a-long-start-pass" });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe("facilitator");
    expect(r.body.user.must_change_password).toBe(1);
    const blocked = await api(r.cookie!.token, "GET", "/api/facilitator/sessions");
    expect(blocked.body.code).toBe("MUST_CHANGE_PASSWORD");
  });
});

describe("health check and proxy-aware origin check", () => {
  it("answers without sign-in and reveals nothing", async () => {
    const r = await api(null, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
  it("accepts the public host a proxy forwards, still blocks other sites", async () => {
    const base = { method: "POST", path: "/api/auth/logout", body: {}, contentType: "application/json", host: "internal:3000" };
    expect((await dispatch({ ...base, origin: "https://pd.example.org", extraHosts: ["pd.example.org"] })).status).toBe(200);
    expect((await dispatch({ ...base, origin: "https://pd.example.org" })).status).toBe(403);
    expect((await dispatch({ ...base, origin: "https://evil.example", extraHosts: ["pd.example.org"] })).status).toBe(403);
  });
});
