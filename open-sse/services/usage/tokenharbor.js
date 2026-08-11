/**
 * TokenHarbor usage — balance + invite code dari dashboard.
 * Auth: accessToken (API key) atau cookie session (loginEmail + password).
 */
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const BASE = "https://tokenharbor.ai";

/**
 * @param {Object} connection - provider connection
 * @param {Object|null} proxyOptions
 * @returns {Promise<Object>} usage data
 */
export async function getTokenHarborUsage(connection, proxyOptions = null) {
  const token = connection.accessToken || connection.apiKey;
  const loginEmail = connection.providerSpecificData?.loginEmail || connection.email;

  if (!token) {
    return { message: "No API key stored — login via dashboard to fetch balance" };
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };

  const out = { provider: "tokenharbor", balance: null, inviteCode: null, quotas: [] };

  // 1. balance — coba beberapa endpoint umum
  for (const ep of ["/api/me", "/api/user", "/api/keys"]) {
    try {
      const res = await proxyAwareFetch(`${BASE}${ep}`, { headers, timeout: 15000 }, proxyOptions);
      if (!res.ok) continue;
      const j = await res.json().catch(() => null);
      if (!j) continue;
      const bal =
        j.balance ?? j.credits ?? j.credit ?? j.usd ?? j.rewardUsd ??
        j.data?.balance ?? j.data?.credits ?? j.data?.usd;
      if (bal != null) {
        out.balance = bal;
        out.quotas.push({ name: "Balance", used: 0, limit: bal, unit: "USD" });
        break;
      }
    } catch {
      /* try next */
    }
  }

  // 2. invite code — dashboard/invites page
  try {
    const res = await proxyAwareFetch(
      `${BASE}/dashboard/invites`,
      { headers: { ...headers, Accept: "text/x-component" }, timeout: 15000 },
      proxyOptions
    );
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/invite=([A-Z0-9-]{6,})/);
      if (m) out.inviteCode = m[1];
    }
  } catch {
    /* non-fatal */
  }

  if (out.balance == null && !out.inviteCode) {
    return { message: "TokenHarbor: balance fetch failed (auth?)" };
  }

  const parts = [];
  if (out.balance != null) parts.push(`$${out.balance}`);
  if (out.inviteCode) parts.push(`invite ${out.inviteCode}`);
  out.summary = parts.join(" · ");
  return out;
}
