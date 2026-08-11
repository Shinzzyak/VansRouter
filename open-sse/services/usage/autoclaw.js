import crypto from "node:crypto";

const BASE_URL = "https://autoglm-api.autoglm.ai";
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

function signHeaders(extra = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex");
  return {
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://autoclaw.z.ai",
    referer: "https://autoclaw.z.ai/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-auth-appid": APP_ID,
    "x-auth-timestamp": ts,
    "x-auth-sign": sign,
    "x-product": "autoclaw",
    "x-version": "1.12.1",
    "x-tm": "web",
    "x-channel": "official",
    "x-client-type": "web",
    "x-trace-id": crypto.randomUUID(),
    "x-lang": "zh-CN",
    ...extra,
  };
}

export async function getAutoclawBalance(accessToken, _providerSpecificData = {}, _proxyOptions = null) {
  if (!accessToken) {
    throw new Error("autoclaw: accessToken required for wallet lookup");
  }
  const token = accessToken.replace(/^Bearer\s+/i, "");

  const [walletRes, expiringRes, sandboxRes] = await Promise.allSettled([
    fetch(`${BASE_URL}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`, {
      method: "GET",
      headers: signHeaders({ authorization: `Bearer ${token}` }),
    }),
    fetch(`${BASE_URL}/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw`, {
      method: "GET",
      headers: signHeaders({ authorization: `Bearer ${token}` }),
    }),
    fetch(`${BASE_URL}/agentdr/v2/assistant/sandbox/list`, {
      method: "GET",
      headers: signHeaders({ authorization: `Bearer ${token}` }),
    }),
  ]);

  const contentType = walletRes.status === "fulfilled" ? (walletRes.value.headers.get("content-type") || "") : "";
  if (walletRes.status !== "fulfilled" || !walletRes.value.ok || !contentType.includes("application/json")) {
    const text = walletRes.status === "fulfilled" ? await walletRes.value.text().catch(() => "") : "";
    const hint = text.startsWith("<") || contentType.includes("text/html")
      ? "token revoked or upstream returned HTML"
      : `${walletRes.status === "fulfilled" ? walletRes.value.status : "rejected"} ${text.slice(0, 200)}`;
    throw Object.assign(new Error(`autoclaw wallet: ${hint}`), {
      recoverable: walletRes.status === "fulfilled" && walletRes.value.status >= 500,
    });
  }

  const json = await walletRes.value.json();
  const data = json.data || json;
  const balance = Number(data.total_balance ?? 0);

  // Expiring points (trial window) — best-effort
  let expiring = null;
  if (expiringRes.status === "fulfilled" && expiringRes.value.ok) {
    try {
      const ex = await expiringRes.value.json();
      const exd = ex.data || {};
      if (exd.expiring_points_text) {
        expiring = {
          text: exd.expiring_points_text,
          points: Number(exd.expiring_points ?? 0),
          expireInDays: Number(exd.expire_time_value ?? 0),
        };
      }
    } catch {
      // ignore
    }
  }

  // Cloud Lobster sandbox (free trial) — best-effort
  let sandbox = null;
  if (sandboxRes.status === "fulfilled" && sandboxRes.value.ok) {
    try {
      const sb = await sandboxRes.value.json();
      const list = (sb.data || {}).sandbox_list || [];
      if (list.length) {
        const s = list[0];
        sandbox = {
          status: s.sandbox_status || "unknown",
          name: s.sandbox_name || "AutoClaw",
          startTs: s.start_timestamp ? Number(s.start_timestamp) * 1000 : null,
        };
      }
    } catch {
      // ignore
    }
  }

  const quotas = {
    points: {
      used: 0,
      total: balance,
      remaining: balance,
      resetAt: null,
      unlimited: false,
    },
  };
  if (expiring) {
    quotas.points.expiring = expiring;
  }

  return {
    provider: "autoclaw",
    plan: "AutoClaw Points",
    quotas,
    balance,
    currency: "points",
    sandbox,
  };
}
