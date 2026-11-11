export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
  /** True when the request never reached the server (offline, server down). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection.", "NETWORK");
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = new ApiError(res.status, String(data.error ?? `Request failed (${res.status})`), String(data.code ?? "ERROR"), data);
    if (typeof window !== "undefined") {
      if (res.status === 401 && !window.location.pathname.startsWith("/login") && path !== "/api/auth/login") {
        window.location.href = "/login";
      } else if (err.code === "MUST_CHANGE_PASSWORD" && window.location.pathname !== "/change-password") {
        window.location.href = "/change-password";
      }
    }
    throw err;
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

export interface Me {
  user: { id: string; email: string; name: string; role: "participant" | "facilitator"; must_change_password: number };
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Mirror of the server's timestamp parser, so the form can warn before saving. Returns undefined when invalid. */
export function parseTime(v: string): number | null | undefined {
  const s = v.trim();
  if (s === "") return null;
  let m = /^(\d{1,5})$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,3}):([0-5]?\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return undefined;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
