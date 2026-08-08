// YYDS temp-mail poll endpoint.
// POST /api/yyds/poll  { address, token, timeout? }
// Polls the inbox until a verification code arrives (or timeout).
import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export async function POST(req) {
  const auth = await requireDashboardAuth(req);
  if (!auth) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { address, token, timeout = 120 } = body || {};
  if (!address || !token) {
    return NextResponse.json({ ok: false, error: "address and token required" }, { status: 400 });
  }
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    "python3",
    ["scripts/python/yyds_client.py", "poll", "--address", address, "--token", token, "--timeout", String(timeout)],
    { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8", timeout: Math.min(timeout + 20, 200_000) },
  );
  if (r.error) return NextResponse.json({ ok: false, error: r.error.message }, { status: 502 });
  if (r.status !== 0) {
    return NextResponse.json({ ok: false, error: (r.stderr || r.stdout || "poll failed").trim() }, { status: 504 });
  }
  const code = r.stdout.match(/CODE=(.+)/)?.[1] || "";
  if (!code) return NextResponse.json({ ok: false, error: "no code in output" }, { status: 504 });
  return NextResponse.json({ ok: true, code });
}
