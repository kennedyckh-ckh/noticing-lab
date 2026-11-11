import crypto from "node:crypto";
import { getDb } from "./db";
import { HttpError, audit, invalid, now, uid } from "./util";
import type { User } from "./types";

export const COOKIE_NAME = "pd_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ---------- passwords (scrypt, per-user salt) ----------

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const DUMMY_HASH = hashPassword("not-a-real-password"); // equalises timing for unknown emails

export function checkPasswordStrength(pw: unknown): string {
  if (typeof pw !== "string") throw invalid("Password is required");
  if (pw.length < 8) throw invalid("Password must be at least 8 characters");
  if (pw.length > 200) throw invalid("Password is too long");
  return pw;
}

// ---------- login throttling (in memory; resets on server restart) ----------

interface Attempt {
  count: number;
  lockedUntil: number;
}
const attempts = new Map<string, Attempt>();
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 5 * 60 * 1000;

export function resetThrottle(): void {
  attempts.clear();
}

/** Shared by login and join-code checks. */
export function throttleCheck(key: string): void {
  const a = attempts.get(key);
  if (a && a.lockedUntil > Date.now()) {
    throw new HttpError(429, "Too many failed attempts. Please wait a few minutes and try again.", "TOO_MANY_ATTEMPTS");
  }
}
export function throttleFail(key: string): void {
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  if (a.lockedUntil && a.lockedUntil <= Date.now()) {
    a.count = 0;
    a.lockedUntil = 0;
  }
  a.count += 1;
  if (a.count >= MAX_FAILED_LOGINS) a.lockedUntil = Date.now() + LOCK_MS;
  attempts.set(key, a);
}
export function throttleClear(key: string): void {
  attempts.delete(key);
}

// ---------- server-side login sessions ----------

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createLoginSession(userId: string): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb()
    .prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .run(sha256(token), userId, now(), expiresAt.toISOString());
  return { token, expiresAt };
}

export function userFromToken(token: string | undefined | null): User | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.must_change_password, s.expires_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as (User & { expires_at: string }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role, must_change_password: row.must_change_password };
}

export function destroyLoginSession(token: string | undefined | null): void {
  if (token) getDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
}

// ---------- accounts ----------

export function normaliseEmail(v: unknown): string {
  if (typeof v !== "string") throw invalid("Email is required");
  const e = v.trim().toLowerCase();
  if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw invalid("Enter a valid email address");
  return e;
}

export function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: "participant" | "facilitator";
  mustChange?: boolean;
}): User {
  const id = uid();
  getDb()
    .prepare(
      "INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(id, input.email, input.name, hashPassword(input.password), input.role, input.mustChange ? 1 : 0, now());
  return { id, email: input.email, name: input.name, role: input.role, must_change_password: input.mustChange ? 1 : 0 };
}

export function login(emailRaw: unknown, password: unknown, ip: string): { user: User; token: string; expiresAt: Date } {
  const email = normaliseEmail(emailRaw);
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    throw new HttpError(401, "Incorrect email or password", "BAD_CREDENTIALS");
  }
  const key = `login|${email}|${ip}`;
  throttleCheck(key);
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | (User & { password_hash: string })
    | undefined;
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH) && !!row;
  if (!ok || !row) {
    throttleFail(key);
    audit(null, row?.id ?? null, "login_failed", { email });
    throw new HttpError(401, "Incorrect email or password", "BAD_CREDENTIALS");
  }
  throttleClear(key);
  const { token, expiresAt } = createLoginSession(row.id);
  audit(null, row.id, "login", {});
  return {
    user: { id: row.id, email: row.email, name: row.name, role: row.role, must_change_password: row.must_change_password },
    token,
    expiresAt,
  };
}

export function changePassword(user: User, token: string, current: unknown, next: unknown): void {
  const db = getDb();
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
  if (typeof current !== "string" || !verifyPassword(current, row.password_hash)) {
    throw new HttpError(401, "Your current password is incorrect", "BAD_CREDENTIALS");
  }
  const pw = checkPasswordStrength(next);
  if (pw === current) throw invalid("Choose a different password from the current one");
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(pw), user.id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?").run(user.id, sha256(token));
  })();
  audit(null, user.id, "password_changed", {});
}
