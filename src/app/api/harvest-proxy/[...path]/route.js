import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

const HARVEST_BASE = "http://127.0.0.1:3088";

// Internal harvest-console session (hsess cookie) — cached in memory.
// The VansRouter BFF authenticates ONCE to the harvest console with its own
// admin credentials, then relays requests with the harvested cookie.
let hsessCookie = null;
let hsessCookieAt = 0;
const HSESS_TTL_MS = 1000 * 60 * 60 * 7; // harvest SESSION_TTL is 8h — refresh at 7h

async function ensureHarvestSession() {
  if (hsessCookie && Date.now() - hsessCookieAt < HSESS_TTL_MS) return null;

  const user = process.env.HARVEST_ADMIN_USER;
  const pass = process.env.HARVEST_ADMIN_PW;
  if (!user || !pass) {
    return { error: "HARVEST_ADMIN_USER / HARVEST_ADMIN_PW not configured on server" };
  }

  const loginRes = await fetch(`${HARVEST_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
    cache: "no-store",
  });
  if (!loginRes.ok) {
    return { error: `harvest login failed (${loginRes.status})` };
  }
  const setCookie = loginRes.headers.get("set-cookie") || "";
  const match = setCookie.match(/hsess=([^;]+)/);
  if (!match) {
    return { error: "harvest login did not issue hsess cookie" };
  }
  hsessCookie = match[1];
  hsessCookieAt = Date.now();
  return null;
}

async function proxyRequest(request, path) {
  const sessionError = await ensureHarvestSession();
  if (sessionError) {
    return NextResponse.json({ error: sessionError.error }, { status: 502 });
  }

  const segments = path.map(decodeURIComponent);
  const url = `${HARVEST_BASE}/api/${segments.map(encodeURIComponent).join("/")}`;

  const headers = {
    accept: "application/json",
    cookie: `hsess=${hsessCookie}`,
  };
  if (request.headers.get("content-type")) {
    headers["content-type"] = request.headers.get("content-type");
  }

  const init = { method: request.method, headers, cache: "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.text();
    if (body) init.body = body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const upstream = await fetch(url, { ...init, signal: controller.signal });
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "";
    // If the session expired mid-flight, retry once with a fresh login.
    if (upstream.status === 401 && text.includes("unauthorized") && hsessCookie) {
      hsessCookie = null;
      return proxyRequest(request, path);
    }
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": contentType || "application/json" },
    });
  } catch (e) {
    const aborted = e.name === "AbortError";
    return NextResponse.json(
      { error: aborted ? "harvest console timeout" : `harvest console error: ${e.message}` },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function authorized(request) {
  return requireDashboardAuth(request);
}

export async function GET(request, { params }) {
  if (!await authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}

export async function POST(request, { params }) {
  if (!await authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}

export async function PUT(request, { params }) {
  if (!await authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}

export async function DELETE(request, { params }) {
  if (!await authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}
