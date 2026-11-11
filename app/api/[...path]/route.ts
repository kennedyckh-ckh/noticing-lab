import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, dispatch } from "@/lib/router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  let body: unknown = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text();
    if (text.length > 200_000) return NextResponse.json({ error: "Request too large", code: "TOO_LARGE" }, { status: 413 });
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: "Invalid JSON", code: "VALIDATION" }, { status: 400 });
      }
    }
  }
  const query: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => (query[k] = v));
  const res = await dispatch({
    method: req.method,
    path: "/api/" + path.join("/"),
    token: req.cookies.get(COOKIE_NAME)?.value ?? null,
    body,
    query,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local",
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    extraHosts: [req.headers.get("x-forwarded-host")?.split(",")[0]?.trim(), process.env.PUBLIC_HOST?.trim()].filter((h): h is string => !!h),
    contentType: body === undefined ? undefined : req.headers.get("content-type"),
  });
  let out: NextResponse;
  if (res.raw) {
    out = new NextResponse(res.raw.text, {
      status: 200,
      headers: {
        "content-type": res.raw.contentType,
        "content-disposition": `attachment; filename="${res.raw.filename}"`,
      },
    });
  } else {
    out = NextResponse.json(res.body ?? {}, { status: res.status });
  }
  out.headers.set("cache-control", "no-store");
  if (res.cookie) {
    if (res.cookie.token) {
      out.cookies.set(COOKIE_NAME, res.cookie.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "1",
        path: "/",
        expires: res.cookie.expires,
      });
    } else {
      out.cookies.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    }
  }
  return out;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
