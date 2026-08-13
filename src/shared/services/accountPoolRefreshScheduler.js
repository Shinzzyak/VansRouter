// Scheduled bulk refresh for account pool (grok-cli etc).
//
// User-configurable cron-like schedule (settings.refreshSchedule):
//   { enabled: true, times: ["03:00", "15:30"], timezone: "Asia/Jakarta", provider: "grok-cli" }
// Every 60s tick: if current HH:MM matches a configured time, refresh EVERY
// active account of the provider in the pool. Manual refresh per account
// stays available via PUT /api/account-pool/refresh.
//
// Coexists with the built-in 5-min background auto-refresh
// (backgroundTokenRefresh.js) — this is an additional scheduled full sweep,
// not a replacement.
import "open-sse/index.js";

import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";
import { getProviderConnections } from "@/lib/localDb.js";
import { getSettings } from "@/lib/db/index.js";
import { isNonServerRuntime } from "@/sse/services/backgroundTokenRefresh.js";

const TICK_MS = 60 * 1000;
const g = (global.__accountPoolRefreshScheduler ??= {
  interval: null,
  running: false,
  lastFireKey: "",
});

function nowParts(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  return `${get("hour")}:${get("minute")}`;
}

export async function refreshAllAccounts(provider = "grok-cli", log = console.log) {
  const conns = await getProviderConnections();
  const targets = conns.filter(
    (c) => c.provider === provider && c.isActive && (c.data?.refreshToken || c.refreshToken)
  );
  log(`[account-pool-scheduler] sweeping ${targets.length} ${provider} accounts`);
  let ok = 0;
  let fail = 0;
  await Promise.allSettled(
    targets.map(async (conn) => {
      try {
        const result = await refreshProviderCredentials(provider, {
          id: conn.id,
          refreshToken: conn.refreshToken || conn.data?.refreshToken,
          accessToken: conn.accessToken || conn.data?.accessToken,
          expiresAt: conn.expiresAt || conn.data?.expiresAt,
        });
        if (result?.accessToken || result?.access_token) ok += 1;
        else fail += 1;
      } catch (err) {
        fail += 1;
        log(`[account-pool-scheduler] refresh fail ${conn.email}: ${String(err).slice(0, 120)}`);
      }
    })
  );
  log(`[account-pool-scheduler] sweep done: ${ok} ok, ${fail} fail`);
  return { ok, fail };
}

async function tick() {
  if (g.running) return;
  try {
    const settings = await getSettings();
    const sched = settings?.refreshSchedule;
    if (!sched?.enabled || !Array.isArray(sched.times) || sched.times.length === 0) return;
    const hhmm = nowParts(sched.timezone);
    if (!sched.times.includes(hhmm)) return;
    const fireKey = `${sched.provider || "grok-cli"}@${hhmm}`;
    if (g.lastFireKey === fireKey) return; // already fired this minute
    g.lastFireKey = fireKey;
    g.running = true;
    try {
      await refreshAllAccounts(sched.provider || "grok-cli");
    } finally {
      g.running = false;
    }
  } catch (err) {
    console.log(`[account-pool-scheduler] tick error: ${String(err).slice(0, 200)}`);
  }
}

export function startAccountPoolRefreshScheduler() {
  if (isNonServerRuntime()) return;
  if (g.interval) return;
  g.interval = setInterval(tick, TICK_MS);
  console.log("[account-pool-scheduler] started (60s tick)");
  // initial check shortly after boot
  setTimeout(tick, 5_000);
}
