import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Compression analytics live in one kv row rather than a table: the set is
// machine-written, read as a whole on every dashboard load, and needs no
// querying beyond "since when". See open-sse/rtk/analytics.js for the producer.
const SCOPE = "compressionAnalytics";
const SUMMARY_KEY = "summary";

// Hourly scalar buckets for the trend chart; 720 = 30 days.
const MAX_HOURS = 720;
// Distinct providers/models/modes are bounded in practice; cap guards a
// pathological upstream that echoes a unique model id per request.
const MAX_DIMENSION_KEYS = 200;
const MAX_TOP_SAVERS = 20;

function emptySummary() {
  return {
    version: 1,
    hours: {},
    byMode: {},
    byProvider: {},
    byModel: {},
    bySkipReason: {},
    topSavers: [],
  };
}

function hourKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 13);
}

function bump(map, key, fields) {
  if (!key) return;
  if (!map[key]) {
    if (Object.keys(map).length >= MAX_DIMENSION_KEYS) return;
    map[key] = { count: 0, tokensSaved: 0, originalTokens: 0, durationMs: 0, skipped: 0 };
  }
  const row = map[key];
  row.count += fields.count;
  row.tokensSaved += fields.tokensSaved;
  row.originalTokens += fields.originalTokens;
  row.durationMs += fields.durationMs;
  row.skipped += fields.skipped;
}

async function readSummary(db) {
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, SUMMARY_KEY]);
  return row ? parseJson(row.value, null) || emptySummary() : emptySummary();
}

async function writeSummary(db, summary) {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, SUMMARY_KEY, stringifyJson(summary)]
  );
}

// Fold drained events into the stored aggregates. Safe to call with an empty
// list (no-op) and safe to call concurrently: the read-modify-write is one
// synchronous transaction, so no JS yield can interleave two folds.
export async function recordCompressionEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 0;

  const db = await getAdapter();
  let recorded = 0;

  db.transaction(() => {
    const summary = readSummarySync(db);
    for (const evt of events) {
      const originalTokens = Math.max(0, Math.round(evt.originalTokens || 0));
      const tokensSaved = Math.max(0, Math.round(evt.tokensSaved || 0));
      const durationMs = Math.max(0, Math.round(evt.durationMs || 0));
      const skipped = evt.skipped ? 1 : 0;
      const fields = { count: 1, tokensSaved, originalTokens, durationMs, skipped };

      const hk = hourKey(evt.timestamp) || hourKey(new Date().toISOString());
      if (!summary.hours[hk]) summary.hours[hk] = { count: 0, tokensSaved: 0, originalTokens: 0, durationMs: 0, skipped: 0 };
      const hour = summary.hours[hk];
      hour.count += 1;
      hour.tokensSaved += tokensSaved;
      hour.originalTokens += originalTokens;
      hour.durationMs += durationMs;
      hour.skipped += skipped;

      bump(summary.byMode, evt.mode, fields);
      bump(summary.byProvider, evt.provider, fields);
      bump(summary.byModel, evt.model, fields);
      if (evt.skipReason) {
        summary.bySkipReason[evt.skipReason] = (summary.bySkipReason[evt.skipReason] || 0) + 1;
      }

      if (tokensSaved > 0) {
        summary.topSavers.push({
          requestId: evt.requestId || null,
          timestamp: evt.timestamp,
          provider: evt.provider || null,
          model: evt.model || null,
          mode: evt.mode,
          originalTokens,
          compressedTokens: Math.max(0, originalTokens - tokensSaved),
          tokensSaved,
          savingsPct: originalTokens > 0 ? (tokensSaved * 100) / originalTokens : 0,
          durationMs,
        });
        summary.topSavers.sort((a, b) => b.tokensSaved - a.tokensSaved);
        if (summary.topSavers.length > MAX_TOP_SAVERS) summary.topSavers.length = MAX_TOP_SAVERS;
      }

      recorded += 1;
    }

    // Trim the oldest hour buckets so the kv row cannot grow without bound.
    const keys = Object.keys(summary.hours).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_HOURS))) delete summary.hours[k];

    writeSummary(db, summary);
  });

  return recorded;
}

// Same read the transaction body needs, without awaiting the adapter twice.
function readSummarySync(db) {
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, SUMMARY_KEY]);
  return row ? parseJson(row.value, null) || emptySummary() : emptySummary();
}

const SINCE_MS = { "24h": 24 * 3600e3, "7d": 7 * 24 * 3600e3, "30d": 30 * 24 * 3600e3 };

function cutoffFor(since) {
  if (since === "all") return null;
  const ms = SINCE_MS[since] ?? SINCE_MS["24h"];
  return Date.now() - ms;
}

// Response shape mirrors 9router-go's /api/analytics/compression summary.
//
// `byMode` / `byProvider` / `byModel` / `bySkipReason` are ALL-TIME: the kv row
// keeps them as flat counters, so a windowed read cannot slice them without
// storing a map per hour. Totals and the hourly trend DO honour `since`, and
// the response says so in `dimensionScope` rather than pretending otherwise.
export async function getCompressionSummary(since = "24h") {
  const db = await getAdapter();
  const summary = await readSummary(db);
  const cutoff = cutoffFor(since);

  let totalRequests = 0;
  let totalTokensSaved = 0;
  let originalTokens = 0;
  let totalDurationMs = 0;
  let totalSkipped = 0;
  const last24h = [];

  const dayAgo = Date.now() - SINCE_MS["24h"];
  for (const [hk, hour] of Object.entries(summary.hours)) {
    const ts = Date.parse(`${hk}:00:00.000Z`);
    if (cutoff === null || ts >= cutoff) {
      totalRequests += hour.count;
      totalTokensSaved += hour.tokensSaved;
      originalTokens += hour.originalTokens;
      totalDurationMs += hour.durationMs;
      totalSkipped += hour.skipped;
    }
    if (ts >= dayAgo) {
      last24h.push({ hour: `${hk}:00:00.000Z`, count: hour.count, tokensSaved: hour.tokensSaved });
    }
  }
  last24h.sort((a, b) => a.hour.localeCompare(b.hour));

  const dims = (map) =>
    Object.fromEntries(
      Object.entries(map).map(([key, row]) => [
        key,
        {
          count: row.count,
          tokensSaved: row.tokensSaved,
          avgSavingsPct: row.originalTokens > 0 ? (row.tokensSaved * 100) / row.originalTokens : 0,
          ...(row.skipped ? { skipped: row.skipped } : {}),
        },
      ])
    );

  return {
    since,
    dimensionScope: "all-time",
    totalRequests,
    totalTokensSaved,
    originalTokens,
    avgSavingsPct: originalTokens > 0 ? (totalTokensSaved * 100) / originalTokens : 0,
    avgDurationMs: totalRequests > 0 ? Math.round(totalDurationMs / totalRequests) : 0,
    totalSkipped,
    roiTokensPerMs: totalDurationMs > 0 ? totalTokensSaved / totalDurationMs : 0,
    byMode: dims(summary.byMode),
    byProvider: dims(summary.byProvider),
    byModel: dims(summary.byModel),
    bySkipReason: summary.bySkipReason,
    last24h,
    topSavers: summary.topSavers,
    // The proxy counts bytes, not tokens: this is an estimate, not an upstream
    // usage receipt. Labelled so a dashboard never renders it as billed usage.
    realUsage: {
      source: "bytes-estimate",
      bytesPerToken: 4,
      requestsWithReceipts: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedUsdSaved: 0,
    },
  };
}

export async function clearCompressionSummary() {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ?`, [SCOPE]);
}
