// The whole quota surface a key can carry, in one place.
//
// Every axis listed here is enforced somewhere real:
//   src/lib/db/repos/apiKeyUsageRepo.js#checkApiKeyLimits  — rate + window gates
//   the balance gate in the same function                  — tokenBalance
// Nothing in this file is decorative, and nothing enforced is missing from it:
// if you add a gate, add its field here and both the resale page and the key
// editor pick it up.
//
// The UI holds strings ("" = unlimited, the seller's mental model), the API
// holds integers or null. `parseQuota` and `sanitizeQuotaLimits` are the only
// two crossings between those worlds, and they are deliberately pure so they
// can be tested without a browser or a database.

export const QUOTA_FIELDS = [
  {
    key: "tokenBalance",
    label: "Saldo total (token)",
    hint: "Kuota seumur hidup key. Habis = request ditolak.",
  },
  {
    key: "maxTokens",
    label: "Token per request",
    hint: "Batas satu request.",
  },
  {
    key: "rateLimitTpm",
    label: "Token per menit (TPM)",
    hint: "Token yang boleh lewat tiap menit.",
  },
  {
    key: "rateLimitConcurrency",
    label: "Request barengan",
    hint: "Request yang boleh jalan bersamaan.",
  },
  { key: "rpm", label: "Request per menit", hint: "" },
  { key: "rph", label: "Request per jam", hint: "" },
  { key: "rpd", label: "Request per hari", hint: "" },
  { key: "maxTokensDaily", label: "Token per hari", hint: "" },
  { key: "tokens5h", label: "Token per 5 jam", hint: "" },
  { key: "tokensWeekly", label: "Token per minggu", hint: "" },
  { key: "tokensMonthly", label: "Token per bulan", hint: "" },
];

const QUOTA_KEYS = QUOTA_FIELDS.map((f) => f.key);

// `allowedIps` and `personaInject` ride along with a code because a seller may
// want the key a code buys to be locked to a source or to skip the persona.
// They are not quota, so they are not rendered as quota fields.
const EXTRA_KEYS = ["allowedIps", "personaInject"];

/** Blank editor state: every axis unlimited. */
export function emptyQuota() {
  return Object.fromEntries(QUOTA_FIELDS.map((f) => [f.key, ""]));
}

/**
 * Existing record → editor state. Numbers become strings so the inputs stay
 * plain text fields; null/undefined becomes "" (unlimited).
 * @param {object} source key or code row
 */
export function quotaFromKey(source = {}) {
  return Object.fromEntries(
    QUOTA_FIELDS.map((f) => [f.key, source?.[f.key] === null || source?.[f.key] === undefined ? "" : String(source[f.key])])
  );
}

/**
 * Editor state → API limits. "" / junk / negative → null, which every consumer
 * reads as "no gate on this axis".
 * @returns {{ limits: object, set: number }} limits plus how many axes are set
 */
export function parseQuota(values = {}) {
  const limits = {};
  let set = 0;
  for (const key of QUOTA_KEYS) {
    const raw = values[key];
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    if (text === "") {
      limits[key] = null;
      continue;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      limits[key] = null;
      continue;
    }
    limits[key] = Math.floor(n);
    set += 1;
  }
  return { limits, set };
}

/**
 * Server-side sanitizer for limits arriving from a client (a code batch, a key
 * mint). Unknown keys are dropped rather than stored: the columns behind them
 * would not exist anyway, and a silent junk column is worse than a 400 nobody
 * needed. Non-numeric or negative values become null = unlimited.
 * @returns {{ ok: boolean, error?: string, limits: object, set: number }}
 */
export function sanitizeQuotaLimits(input) {
  if (input === null || input === undefined) return { ok: true, limits: {}, set: 0 };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "limits must be an object", limits: {}, set: 0 };
  }

  const { limits, set } = parseQuota(input);

  if (input.allowedIps !== undefined && input.allowedIps !== null) {
    const ips = input.allowedIps;
    if (!Array.isArray(ips) || ips.some((ip) => typeof ip !== "string" || !ip.trim())) {
      return { ok: false, error: "limits.allowedIps must be an array of non-empty strings", limits: {}, set: 0 };
    }
    limits.allowedIps = ips.map((ip) => ip.trim());
  } else {
    limits.allowedIps = null;
  }

  if (input.personaInject === false) limits.personaInject = false;

  return { ok: true, limits, set: set + (limits.allowedIps ? 1 : 0) };
}

/** True when a code carries any axis at all — the "not an empty code" check. */
export function hasQuota(limits) {
  if (!limits) return false;
  return QUOTA_KEYS.some((key) => limits[key] !== null && limits[key] !== undefined)
    || (Array.isArray(limits.allowedIps) && limits.allowedIps.length > 0)
    || limits.personaInject === false;
}

function shortTokens(n) {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}jt`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

/**
 * One line a seller can read at a glance, e.g.
 * "5jt token · 60/menit · 20jt TPM". Unlimited axes are omitted, and a key with
 * nothing set returns "" so callers can decide what "no limit" reads like.
 */
export function quotaSummary(source = {}) {
  const parts = [];
  if (source.tokenBalance != null) parts.push(`${shortTokens(source.tokenBalance)} token`);
  if (source.rateLimitTpm != null) parts.push(`${shortTokens(source.rateLimitTpm)} TPM`);
  if (source.rateLimitConcurrency != null) parts.push(`${source.rateLimitConcurrency} barengan`);
  if (source.rpm != null) parts.push(`${source.rpm}/menit`);
  if (source.rph != null) parts.push(`${source.rph}/jam`);
  if (source.rpd != null) parts.push(`${source.rpd}/hari`);
  if (source.maxTokens != null) parts.push(`maks ${shortTokens(source.maxTokens)}/request`);
  if (source.maxTokensDaily != null) parts.push(`${shortTokens(source.maxTokensDaily)}/hari`);
  if (source.tokens5h != null) parts.push(`${shortTokens(source.tokens5h)}/5jam`);
  if (source.tokensWeekly != null) parts.push(`${shortTokens(source.tokensWeekly)}/minggu`);
  if (source.tokensMonthly != null) parts.push(`${shortTokens(source.tokensMonthly)}/bulan`);
  return parts.join(" · ");
}
