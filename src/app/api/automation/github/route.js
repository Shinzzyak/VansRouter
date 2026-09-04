import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections } from "@/models";

/**
 * POST /api/automation/github — inject harvested OAuth tokens (id_007-github-farm).
 *
 * Body: { platform: "tabiai"|"gorouter"|"codebuddy-intl", token, email?, name? }
 *   - token may be multi-line (one token per line) for bulk import.
 *   - CodeBuddy tokens are JWTs: email/sub/exp are parsed from the payload.
 *   - Dedup: skip if a connection with the same accessToken already exists.
 *
 * Mirrors python3 main.py inject from src/agents/id_007-github-farm/.
 */

const PLATFORMS = {
  tabiai: { authType: "apikey", label: "Tabi AI" },
  gorouter: { authType: "apikey", label: "GoRouter" },
  "codebuddy-intl": { authType: "oauth", label: "CodeBuddy Global" },
};

function parseJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { platform, email = "", name = "" } = body;
  const tokens = String(body.token || "")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

  const cfg = PLATFORMS[platform];
  if (!cfg) {
    return NextResponse.json({ error: `Unknown platform: ${platform}` }, { status: 400 });
  }
  if (tokens.length === 0) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const existing = await getProviderConnections({ provider: platform });
  const knownTokens = new Set(existing.map((c) => c.accessToken).filter(Boolean));

  let inserted = 0;
  let duplicates = 0;
  let failed = 0;
  const errors = [];

  for (const token of tokens) {
    try {
      if (knownTokens.has(token)) {
        duplicates += 1;
        continue;
      }

      let connEmail = email || null;
      let expiresAt = null;
      let userId = null;
      if (platform === "codebuddy-intl") {
        const payload = parseJwtPayload(token);
        if (!payload) throw new Error("Malformed JWT (expected 3-part CodeBuddy token)");
        connEmail = connEmail || payload.email || payload.preferred_username || null;
        userId = payload.sub || null;
        if (payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
      }

      await createProviderConnection({
        provider: platform,
        authType: cfg.authType,
        name: name || connEmail || `${cfg.label} ${existing.length + inserted + 1}`,
        email: connEmail,
        accessToken: token,
        refreshToken: token,
        expiresAt,
        testStatus: "active",
        providerSpecificData: {
          userId,
          importSource: "github-harvest",
          importedAt: new Date().toISOString(),
        },
      });
      knownTokens.add(token);
      inserted += 1;
    } catch (e) {
      failed += 1;
      errors.push({ token: `${token.slice(0, 12)}…`, error: e.message });
    }
  }

  return NextResponse.json({ success: failed === 0, inserted, duplicates, failed, errors });
}
