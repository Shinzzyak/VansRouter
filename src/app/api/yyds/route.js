// YYDS temp-mail API routes for VansRouter.
// Backed by scripts/python/yyds_client.py (requests-only, no heavy deps).
// Create/poll requires an account JWT (YYDS_JWT env or settings.yydsJwt) —
// API key alone is rejected by the upstream for /accounts & /messages
// (verified 2026-08-08).
import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

function getEnv() {
  return {
    jwt: process.env.YYDS_JWT || "",
    apiKey: process.env.YYDS_API_KEY || "",
  };
}

async function getYydsCredentials() {
  const { getSettings } = await import("@/lib/localDb");
  const settings = await getSettings();
  const env = getEnv();
  return {
    jwt: settings.yydsJwt || env.jwt,
    apiKey: settings.yydsApiKey || env.apiKey,
  };
}

async function runPython(args, env) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python3", ["scripts/python/yyds_client.py", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "python failed").trim() };
  return { ok: true, stdout: r.stdout.trim() };
}

// GET /api/yyds/domains — list verified domains (works with API key)
export async function GET(request) {
  const auth = await requireDashboardAuth(request);
  if (!auth) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { apiKey, jwt } = await getYydsCredentials();
  const r = await runPython(
    ["domains", ...(jwt ? ["--jwt", jwt] : apiKey ? ["--api-key", apiKey] : [])],
    { YYDS_API_KEY: apiKey, YYDS_JWT: jwt },
  );
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  const lines = r.stdout.split("\n").filter(Boolean);
  const domains = lines.map((l) => {
    const m = l.match(/^(.+?) \| verified=(true|false) public=(true|false) mx=(true|false)$/i);
    return m
      ? { domain: m[1], isVerified: m[2].toLowerCase() === "true", isPublic: m[3].toLowerCase() === "true", isMxValid: m[4].toLowerCase() === "true" }
      : { raw: l };
  });
  return NextResponse.json({ ok: true, domains });
}

// POST /api/yyds/create — create a fresh inbox on an OWNED domain
// (requires an API key with domainScope=own — 'Herm' key; no account JWT needed)
export async function POST(req) {
  const auth = await requireDashboardAuth(req);
  if (!auth) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { apiKey, jwt } = await getYydsCredentials();
  let body = {};
  try {
    body = await req.json();
  } catch {
    // empty body allowed
  }
  const domain = typeof body?.domain === "string" && body.domain.trim() ? body.domain.trim() : "";
  const address = typeof body?.address === "string" && body.address.trim() ? body.address.trim() : "";
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "YYDS API key not configured — set it in Profile → YYDS Temp Mail" },
      { status: 400 },
    );
  }
  const args = ["create-owned", "--api-key", apiKey];
  if (domain) args.push("--domain", domain);
  if (address) args.push("--address", address);
  const r = await runPython(args, { YYDS_API_KEY: apiKey, YYDS_JWT: jwt });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  const addr = r.stdout.match(/ADDRESS=(.+)/)?.[1] || "";
  const tok = r.stdout.match(/TOKEN=(.+)/)?.[1] || "";
  if (!addr || !tok) return NextResponse.json({ ok: false, error: "unexpected output: " + r.stdout }, { status: 502 });
  return NextResponse.json({ ok: true, address: addr, token: tok });
}
