// Bulk-create YYDS inboxes — for bulk-import flows that need fresh temp emails.
// Creates N inboxes on an OWNED domain (API key scope=own, no account JWT needed).
// Returns addresses + tokens so callers can pass them into bulk-import jobs.
import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

async function getYydsCredentials() {
  const { getSettings } = await import("@/lib/localDb");
  const settings = await getSettings();
  return {
    jwt: settings.yydsJwt || process.env.YYDS_JWT || "",
    apiKey: settings.yydsApiKey || process.env.YYDS_API_KEY || "",
  };
}

async function runPython(args, env) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python3", ["scripts/python/yyds_client.py", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000, // N inboxes × ~5s each; generous
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "python failed").trim() };
  return { ok: true, stdout: r.stdout.trim() };
}

// POST /api/yyds/bulk-create — create N inboxes (default 1, max 20)
export async function POST(req) {
  const auth = await requireDashboardAuth(req);
  if (!auth) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { apiKey } = await getYydsCredentials();
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "YYDS API key not configured — set it in Profile → YYDS Temp Mail" },
      { status: 400 },
    );
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    // empty body allowed
  }

  const domain = typeof body?.domain === "string" && body.domain.trim() ? body.domain.trim() : "";
  const count = Math.min(Math.max(Number(body?.count) || 1, 1), 20);
  const prefix = typeof body?.prefix === "string" && body.prefix.trim() ? body.prefix.trim() : "vr";

  if (!domain) {
    return NextResponse.json({ ok: false, error: "domain is required" }, { status: 400 });
  }

  const inboxes = [];
  const errors = [];
  for (let i = 0; i < count; i += 1) {
    const address = `${prefix}-${Date.now().toString(36)}-${i}`;
    const args = ["create-owned", "--api-key", apiKey, "--domain", domain, "--address", address];
    const r = await runPython(args, { YYDS_API_KEY: apiKey });
    if (!r.ok) {
      errors.push({ address, error: r.error });
      continue;
    }
    const addr = r.stdout.match(/ADDRESS=(.+)/)?.[1] || address;
    const tok = r.stdout.match(/TOKEN=(.+)/)?.[1] || "";
    inboxes.push({ address: addr, token: tok });
  }

  return NextResponse.json({ ok: true, created: inboxes.length, inboxes, errors });
}
