import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PROVIDER_ID = "cloudflare-ai";

async function cloudflareFetch(path, token, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  let payload = null;
  try { payload = await res.json(); } catch {}
  return { res, payload };
}

async function verifyCloudflareToken(token) {
  const { res, payload } = await cloudflareFetch("/user/tokens/verify", token, { method: "GET" });
  return { ok: res.ok && payload?.success !== false, status: res.status, payload };
}

async function testWorkersAi(token, accountId) {
  const { res, payload } = await cloudflareFetch(
    `/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }], max_tokens: 1 }),
    }
  );
  const ok = res.status !== 401 && res.status !== 403 && res.status !== 404;
  return { ok, status: res.status, payload };
}

async function saveCloudflareConnection({ token, accountId, name, workerAi }) {
  const { createProviderConnection } = await import("@/models");
  const connection = await createProviderConnection({
    provider: PROVIDER_ID,
    authType: "apikey",
    name: name || `Cloudflare ${accountId}`,
    apiKey: token,
    testStatus: workerAi.ok ? "active" : "unknown",
    providerSpecificData: {
      accountId,
      automation: "bulk-token-import",
      tokenVerifiedAt: new Date().toISOString(),
      workerAiStatus: workerAi.status,
    },
  });
  return { connection };
}

async function importCloudflareToken({ token, accountId, name }) {
  if (!token || !accountId) {
    const err = new Error("Missing apiToken or accountId");
    err.code = "missing_fields";
    throw err;
  }

  const tokenCheck = await verifyCloudflareToken(token);
  if (!tokenCheck.ok) {
    const err = new Error(`Token verify failed (HTTP ${tokenCheck.status})`);
    err.code = "token_invalid";
    err.status = tokenCheck.status;
    err.payload = tokenCheck.payload;
    throw err;
  }

  const workerAi = await testWorkersAi(token, accountId);
  if (!workerAi.ok) {
    const err = new Error(`Workers AI test failed (HTTP ${workerAi.status})`);
    err.code = "workers_ai_failed";
    err.status = workerAi.status;
    err.payload = workerAi.payload;
    throw err;
  }

  const { connection } = await saveCloudflareConnection({ token, accountId, name, workerAi });
  return { connection, tokenCheck, workerAi };
}

function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        apiToken: parsed.apiToken || parsed.apiKey || parsed.token || "",
        accountId: parsed.accountId || parsed.account_id || "",
        name: parsed.name || "",
      };
    } catch {
      return { invalid: true };
    }
  }

  const parts = trimmed.split("|").map((part) => part.trim());
  const apiToken = parts[0] || "";
  const accountId = parts[1] || "";
  const name = parts[2] || "";
  if (!apiToken || !accountId) return { invalid: true };
  return { apiToken, accountId, name };
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
  }

  const rawText = String(body?.text || "").trim();
  const singleToken = String(body?.apiToken || "").trim();
  const singleAccountId = String(body?.accountId || "").trim();
  const singleName = String(body?.name || "").trim();

  const entries = [];

  if (rawText) {
    const lines = rawText.split("\n");
    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (parsed.invalid) {
        return NextResponse.json(
          { error: "Invalid line format. Use apiToken|accountId|optionalName or JSON." },
          { status: 400 }
        );
      }
      entries.push(parsed);
    }
  } else if (singleToken && singleAccountId) {
    entries.push({ apiToken: singleToken, accountId: singleAccountId, name: singleName });
  }

  if (!entries.length) {
    return NextResponse.json(
      { error: "Provide at least one entry: apiToken|accountId or JSON." },
      { status: 400 }
    );
  }

  const results = [];
  const failures = [];
  let imported = 0;

  for (const [index, entry] of entries.entries()) {
    try {
      const { connection, tokenCheck, workerAi } = await importCloudflareToken({
        token: entry.apiToken,
        accountId: entry.accountId,
        name: entry.name,
      });
      imported += 1;
      results.push({
        line: index + 1,
        success: true,
        connectionId: connection.id,
        accountId: entry.accountId,
        name: connection.name,
        tokenStatus: tokenCheck.payload?.result?.status || "valid",
        workerAiStatus: workerAi.status,
      });
    } catch (error) {
      failures.push({
        line: index + 1,
        accountId: entry.accountId,
        error: error.message,
        code: error.code || "failed",
      });
    }
  }

  const response = {
    success: failures.length === 0,
    imported,
    total: entries.length,
    failed: failures.length,
    results,
  };
  if (failures.length > 0) response.failures = failures;

  return NextResponse.json(response, { status: failures.length === entries.length ? 422 : 200 });
}
