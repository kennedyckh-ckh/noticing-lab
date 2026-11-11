import crypto from "node:crypto";
import { getDb } from "./db";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = "ERROR",
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const now = (): string => new Date().toISOString();
export const uid = (): string => crypto.randomUUID();

export const notFound = (what = "Not found"): HttpError => new HttpError(404, what, "NOT_FOUND");
export const forbidden = (msg = "You do not have permission to do that", code = "FORBIDDEN"): HttpError =>
  new HttpError(403, msg, code);
export const conflict = (msg: string, code: string, extra?: Record<string, unknown>): HttpError =>
  new HttpError(409, msg, code, extra);
export const invalid = (msg: string): HttpError => new HttpError(400, msg, "VALIDATION");

function cleanText(s: string): string {
  return s.replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

/** Validate a text field. Returns "" when absent and not required. */
export function str(
  v: unknown,
  name: string,
  max: number,
  opts: { required?: boolean; trim?: boolean } = {},
): string {
  if (v === undefined || v === null) {
    if (opts.required) throw invalid(`${name} is required`);
    return "";
  }
  if (typeof v !== "string") throw invalid(`${name} must be text`);
  let s = cleanText(v);
  if (opts.trim !== false) s = s.trim();
  if (opts.required && s.trim().length === 0) throw invalid(`${name} is required`);
  if (s.length > max) throw invalid(`${name} is too long (max ${max} characters)`);
  return s;
}

/** Parse "90", "1:30" or "0:01:30" into seconds. Empty means no timestamp. */
export function parseTimestamp(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || v > 86400) throw invalid("Timestamp is out of range");
    return v;
  }
  if (typeof v !== "string") throw invalid("Timestamp must be like 1:30");
  const s = v.trim();
  if (s === "") return null;
  let m = /^(\d{1,5})$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,3}):([0-5]?\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  throw invalid("Timestamp must look like 1:30 or 0:01:30");
}

export function formatTimestamp(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function audit(
  sessionId: string | null,
  actorId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
): void {
  getDb()
    .prepare("INSERT INTO audit_log (session_id, actor_id, action, detail_json, created_at) VALUES (?,?,?,?,?)")
    .run(sessionId, actorId, action, JSON.stringify(detail), now());
}

export function randomCode(len: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function tempPassword(): string {
  return randomCode(4) + "-" + randomCode(4) + "-" + randomCode(4);
}

export function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}
