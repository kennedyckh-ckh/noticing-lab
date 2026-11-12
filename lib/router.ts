/**
 * One router for the whole API. Each route declares the role it needs; the dispatcher enforces
 * authentication, role, forced password change and CSRF BEFORE the handler runs, so a handler
 * cannot forget it. Handlers then apply resource-level checks (session / group / stage).
 * The Next.js route file and the automated tests both call `dispatch`, so tests exercise the real code path.
 */
import { changePassword, destroyLoginSession, login, userFromToken, COOKIE_NAME } from "./auth";
import { asRecord, HttpError } from "./util";
import { getDb } from "./db";
import type { User } from "./types";
import * as P from "./participant";
import * as F from "./facilitator";
import * as SM from "./session-management";
import { reopenPart1 } from "./reopen-part1";
import { exportSession } from "./export";
import * as AI from "./ai-service";
import { publishedView } from "./ai-service";

export type AuthLevel = "none" | "user" | "participant" | "facilitator";

export interface Ctx {
  user: User;
  token: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  ip: string;
  setSessionCookie: (token: string | null, expires?: Date) => void;
}

export interface RawFile {
  __raw: true;
  contentType: string;
  filename: string;
  text: string;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  pattern: string;
  auth: AuthLevel;
  handler: Handler;
  /** allowed even while the account still has a temporary password */
  allowWhileMustChange?: boolean;
}

const r = (method: Route["method"], pattern: string, auth: AuthLevel, handler: Handler, extra: Partial<Route> = {}): Route => ({
  method,
  pattern,
  auth,
  handler,
  ...extra,
});

const part = (v: unknown): 1 | 2 => {
  if (v === 1 || v === 2) return v;
  throw new HttpError(400, "part must be 1 or 2", "VALIDATION");
};

export const routes: Route[] = [
  // ----- health check for hosting platforms: reveals nothing -----
  r("GET", "/api/health", "none", () => {
    getDb().prepare("SELECT 1").get();
    return { ok: true };
  }),

  // ----- auth -----
  r("POST", "/api/auth/login", "none", (c) => {
    const b = asRecord(c.body);
    const res = login(b.email, b.password, c.ip);
    c.setSessionCookie(res.token, res.expiresAt);
    return { user: res.user };
  }),
  r("POST", "/api/auth/logout", "none", (c) => {
    destroyLoginSession(c.token);
    c.setSessionCookie(null);
    return { ok: true };
  }),
  r("GET", "/api/auth/me", "user", (c) => ({ user: c.user }), { allowWhileMustChange: true }),
  r(
    "POST",
    "/api/auth/change-password",
    "user",
    (c) => {
      const b = asRecord(c.body);
      changePassword(c.user, c.token, b.current, b.next);
      return { ok: true };
    },
    { allowWhileMustChange: true },
  ),

  // ----- participant -----
  r("GET", "/api/my/sessions", "participant", (c) => ({ sessions: P.mySessions(c.user) })),
  r("POST", "/api/sessions/join", "participant", (c) => P.joinSession(c.user, asRecord(c.body).code)),
  r("GET", "/api/sessions/:sid/overview", "participant", (c) => P.sessionOverview(c.user, c.params.sid)),
  r("POST", "/api/sessions/:sid/group", "participant", (c) => P.selectGroup(c.user, c.params.sid, asRecord(c.body).group_id)),
  r("GET", "/api/sessions/:sid/shared", "participant", (c) => ({
    ...P.sharedView(c.user, c.params.sid),
    ...publishedView(c.user, c.params.sid),
  })),
  r("GET", "/api/groups/:gid/workspace", "participant", (c) => P.workspace(c.user, c.params.gid)),
  r("POST", "/api/groups/:gid/entries", "participant", (c) => P.createEntry(c.user, c.params.gid, c.body)),
  r("POST", "/api/groups/:gid/submit", "participant", (c) => P.submitPart(c.user, c.params.gid, c.body)),
  r("PATCH", "/api/entries/:eid", "participant", (c) => P.updateEntry(c.user, c.params.eid, c.body)),
  r("DELETE", "/api/entries/:eid", "participant", (c) => P.deleteEntry(c.user, c.params.eid)),

  // ----- facilitator: sessions, groups, roster, questions -----
  r("GET", "/api/facilitator/sessions", "facilitator", (c) => SM.listManagedSessions(c.user)),
  r("POST", "/api/facilitator/sessions", "facilitator", (c) => F.createSession(c.user, c.body)),
  r("POST", "/api/facilitator/sessions/:sid/archive", "facilitator", (c) => SM.setSessionArchived(c.user, c.params.sid, c.body)),
  r("DELETE", "/api/facilitator/sessions/:sid", "facilitator", (c) => SM.deleteManagedSession(c.user, c.params.sid, c.body)),
  r("GET", "/api/facilitator/sessions/:sid", "facilitator", (c) => F.sessionDetail(c.user, c.params.sid)),
  r("PATCH", "/api/facilitator/sessions/:sid", "facilitator", (c) => F.updateSession(c.user, c.params.sid, c.body)),
  r("POST", "/api/facilitator/sessions/:sid/groups", "facilitator", (c) => F.createGroup(c.user, c.params.sid, c.body)),
  r("PATCH", "/api/facilitator/groups/:gid", "facilitator", (c) => F.updateGroup(c.user, c.params.gid, c.body)),
  r("POST", "/api/facilitator/sessions/:sid/participants", "facilitator", (c) => F.createParticipants(c.user, c.params.sid, c.body)),
  r("POST", "/api/facilitator/groups/:gid/authorise", "facilitator", (c) => F.authoriseUser(c.user, c.params.gid, c.body)),
  r("DELETE", "/api/facilitator/groups/:gid/authorise/:uid", "facilitator", (c) => F.deauthoriseUser(c.user, c.params.gid, c.params.uid)),
  r("POST", "/api/facilitator/sessions/:sid/questions", "facilitator", (c) => F.addQuestion(c.user, c.params.sid, c.body)),
  r("PATCH", "/api/facilitator/questions/:qid", "facilitator", (c) => F.updateQuestion(c.user, c.params.qid, c.body)),
  r("DELETE", "/api/facilitator/questions/:qid", "facilitator", (c) => F.deleteQuestion(c.user, c.params.qid)),

  // ----- facilitator: dashboard, stage control, sharing -----
  r("GET", "/api/facilitator/sessions/:sid/dashboard", "facilitator", (c) => F.dashboard(c.user, c.params.sid)),
  r("GET", "/api/facilitator/sessions/:sid/groups/:gid/entries", "facilitator", (c) => F.groupContributions(c.user, c.params.sid, c.params.gid)),
  r("POST", "/api/facilitator/sessions/:sid/groups/:gid/reopen-part1", "facilitator", (c) => reopenPart1(c.user, c.params.sid, c.params.gid, c.body)),
  r("POST", "/api/facilitator/sessions/:sid/unlock-part2", "facilitator", (c) => F.unlockPart2(c.user, c.params.sid, c.body)),
  r("POST", "/api/facilitator/sessions/:sid/override", "facilitator", (c) => {
    const b = asRecord(c.body);
    return F.recordOverride(c.user, c.params.sid, part(b.part), b);
  }),
  r("POST", "/api/facilitator/entries/:eid/share", "facilitator", (c) => F.shareEntry(c.user, c.params.eid, c.body)),

  // ----- facilitator: AI drafts (review, edit, publish) -----
  r("GET", "/api/facilitator/sessions/:sid/ai", "facilitator", (c) => AI.listOutputs(c.user, c.params.sid)),
  r("POST", "/api/facilitator/sessions/:sid/ai/generate", "facilitator", (c) => AI.generate(c.user, c.params.sid, c.body)),
  r("PATCH", "/api/facilitator/ai/:id", "facilitator", (c) => AI.editOutput(c.user, c.params.id, c.body)),
  r("POST", "/api/facilitator/ai/:id/review", "facilitator", (c) => AI.markReviewed(c.user, c.params.id, c.body)),
  r("POST", "/api/facilitator/ai/:id/unpublish", "facilitator", (c) => AI.unpublish(c.user, c.params.id)),
  r("DELETE", "/api/facilitator/ai/:id", "facilitator", (c) => AI.deleteDraft(c.user, c.params.id)),
  r("POST", "/api/facilitator/sessions/:sid/ai/publish-summaries", "facilitator", (c) => AI.publishKind(c.user, c.params.sid, "group_summary", c.body)),
  r("POST", "/api/facilitator/sessions/:sid/ai/reveal-salient", "facilitator", (c) => AI.publishKind(c.user, c.params.sid, "salient_points", c.body)),

  // ----- facilitator: export -----
  r("GET", "/api/facilitator/sessions/:sid/export", "facilitator", (c) => exportSession(c.user, c.params.sid, c.query.format ?? "json", c.query.what ?? "all")),
];

function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
  const segs = path.split("/").filter(Boolean);
  let pathMatched = false;
  for (const route of routes) {
    const rsegs = route.pattern.split("/").filter(Boolean);
    if (rsegs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < rsegs.length; i++) {
      if (rsegs[i].startsWith(":")) {
        try {
          params[rsegs[i].slice(1)] = decodeURIComponent(segs[i]);
        } catch {
          ok = false;
          break;
        }
      } else if (rsegs[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return pathMatched ? "method" : null;
}

export interface DispatchInput {
  method: string;
  path: string;
  token?: string | null;
  body?: unknown;
  query?: Record<string, string>;
  ip?: string;
  /** request Origin and Host headers, for the CSRF check */
  origin?: string | null;
  host?: string | null;
  /** other host names that are legitimately this site (a proxy's forwarded host, PUBLIC_HOST) */
  extraHosts?: string[];
  contentType?: string | null;
}

export interface DispatchResult {
  status: number;
  body?: unknown;
  raw?: RawFile;
  cookie?: { token: string | null; expires?: Date };
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  let cookie: DispatchResult["cookie"];
  try {
    const method = input.method.toUpperCase();
    const m = matchRoute(method, input.path);
    if (m === null) throw new HttpError(404, "Not found", "NOT_FOUND");
    if (m === "method") throw new HttpError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    const { route, params } = m;

    // CSRF: browsers always send Origin on cross-site writes; it must match our host. Bodies must be JSON.
    if (method !== "GET") {
      if (input.origin && input.host) {
        let originHost = "";
        try {
          originHost = new URL(input.origin).host;
        } catch {
          /* invalid */
        }
        if (originHost !== input.host && !(input.extraHosts ?? []).includes(originHost)) throw new HttpError(403, "Cross-site request blocked", "CSRF");
      }
      if (input.body !== undefined && input.contentType !== undefined && input.contentType !== null && !input.contentType.includes("application/json")) {
        throw new HttpError(415, "Send JSON", "UNSUPPORTED_MEDIA_TYPE");
      }
    }

    let user: User | null = null;
    if (route.auth !== "none") {
      user = userFromToken(input.token);
      if (!user) throw new HttpError(401, "Please sign in", "UNAUTHENTICATED");
      if (route.auth === "facilitator" && user.role !== "facilitator") throw new HttpError(403, "Facilitator access required", "FACILITATOR_ONLY");
      if (route.auth === "participant" && user.role !== "participant") throw new HttpError(403, "Participant access required", "PARTICIPANT_ONLY");
      if (user.must_change_password && !route.allowWhileMustChange) {
        throw new HttpError(403, "Please choose a new password before continuing", "MUST_CHANGE_PASSWORD");
      }
    }
    const ctx: Ctx = {
      user: user as User,
      token: input.token ?? "",
      params,
      query: input.query ?? {},
      body: input.body,
      ip: input.ip ?? "unknown",
      setSessionCookie: (token, expires) => {
        cookie = { token, expires };
      },
    };
    const out = await route.handler(ctx);
    if (out && typeof out === "object" && (out as RawFile).__raw) return { status: 200, raw: out as RawFile, cookie };
    return { status: 200, body: out, cookie };
  } catch (e) {
    if (e instanceof HttpError) {
      return { status: e.status, body: { error: e.message, code: e.code, ...(e.extra ?? {}) }, cookie };
    }
    console.error("Unhandled API error", e);
    return { status: 500, body: { error: "Something went wrong on the server. Your work was not lost; please try again.", code: "SERVER_ERROR" } };
  }
}

export { COOKIE_NAME };
