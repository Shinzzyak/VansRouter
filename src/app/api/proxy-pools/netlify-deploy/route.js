import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";
import { RELAY_TARGET_GUARD_SOURCE } from "@/shared/utils/ssrfGuard.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { buildZip, sha1Hex } from "@/lib/relayZip.js";

export const dynamic = "force-dynamic";

const NETLIFY_API = "https://api.netlify.com/api/v1";

// The relay itself: same guard + forwarding contract the Vercel/Deno/Cloudflare
// deploys use, wrapped in Netlify's function signature.
const RELAY_FUNCTION_CODE = `const handler = async (event) => {
  ${RELAY_TARGET_GUARD_SOURCE}
  const headers = event.headers || {};
  const target = headers["x-relay-target"];
  const relayPath = headers["x-relay-path"] || "/";
  if (!target) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing x-relay-target header" }) };
  }

  let targetUrl;
  try {
    const base = target.replace(/\\/+$/, "");
    const path = relayPath.startsWith("/") ? relayPath : "/" + relayPath;
    targetUrl = base + path;
    assertTrustedTarget(targetUrl);
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  const outHeaders = { ...headers };
  delete outHeaders["x-relay-target"];
  delete outHeaders["x-relay-path"];
  delete outHeaders.host;

  const response = await fetch(targetUrl, {
    method: event.httpMethod,
    headers: outHeaders,
    body: event.httpMethod === "GET" || event.httpMethod === "HEAD" ? undefined : (event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : event.body),
  });

  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
    isBase64Encoded: true,
  };
};

export { handler };
`;

const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>relay</title><p>relay</p>`;

function sanitizeSiteName(name) {
  const cleaned = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return cleaned || `relay-${Date.now().toString(36)}`;
}

async function netlifyFetch(path, token, init = {}) {
  const res = await fetch(`${NETLIFY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function pollDeploy(deployId, token, maxMs = 120000) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const { ok, json } = await netlifyFetch(`/deploys/${deployId}`, token);
    if (ok && json?.state === "ready") return json;
    if (ok && ["error", "rejected"].includes(json?.state)) {
      throw new Error(`Deployment failed: ${json.state}`);
    }
    if (Date.now() >= deadline) throw new Error("Deployment timed out");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// POST /api/proxy-pools/netlify-deploy  { netlifyToken, projectName }
export async function POST(request) {
  const auth = await requireDashboardAuth(request);
  if (auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.netlifyToken || "").trim();
    if (!token) {
      return NextResponse.json({ error: "Netlify personal access token is required" }, { status: 400 });
    }

    const siteName = sanitizeSiteName(body.projectName);

    const created = await netlifyFetch("/sites", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: siteName }),
    });
    if (!created.ok) {
      return NextResponse.json(
        { error: created.json?.message || "Failed to create Netlify site" },
        { status: created.status }
      );
    }

    const siteId = created.json?.id;
    const sslUrl = String(created.json?.ssl_url || created.json?.url || "").replace(/\/+$/, "");
    if (!siteId || !sslUrl) {
      return NextResponse.json({ error: "Netlify did not return a site id/url" }, { status: 502 });
    }

    // Netlify's deploy protocol: ask for a deploy, upload the files it says are
    // required, then wait for the state to flip to ready.
    const indexBuf = Buffer.from(INDEX_HTML, "utf8");
    const fnZip = buildZip([
      { name: "relay.js", data: RELAY_FUNCTION_CODE },
      { name: "package.json", data: JSON.stringify({ name: "relay", version: "1.0.0" }) },
    ]);

    const deploy = await netlifyFetch(`/sites/${siteId}/deploys`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!deploy.ok) {
      return NextResponse.json(
        { error: deploy.json?.message || "Failed to create Netlify deploy" },
        { status: deploy.status }
      );
    }

    const deployId = deploy.json?.id;
    const required = Array.isArray(deploy.json?.required) ? deploy.json.required : [];
    const requiredFunctions = Array.isArray(deploy.json?.required_functions) ? deploy.json.required_functions : [];

    if (required.includes(sha1Hex(indexBuf))) {
      const up = await netlifyFetch(`/deploys/${deployId}/files/index.html`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: indexBuf,
      });
      if (!up.ok) {
        return NextResponse.json({ error: up.json?.message || "Failed to upload index.html" }, { status: up.status });
      }
    }

    if (requiredFunctions.includes(sha1Hex(fnZip))) {
      const up = await netlifyFetch(`/deploys/${deployId}/functions/relay`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: fnZip,
      });
      if (!up.ok) {
        return NextResponse.json({ error: up.json?.message || "Failed to upload relay function" }, { status: up.status });
      }
    }

    await pollDeploy(deployId, token);

    const deployUrl = `${sslUrl}/.netlify/functions/relay`;
    const proxyPool = await createProxyPool({
      name: siteName,
      proxyUrl: deployUrl,
      type: "netlify",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    });

    return NextResponse.json({ proxyPool, deployUrl, siteId, deployId }, { status: 201 });
  } catch (error) {
    console.log("Error deploying Netlify relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
