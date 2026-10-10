// Model-deprecation detection, mirroring 9router-go's internal/providers/
// deprecation.go. A model that upstream retired answers 410 Gone (sometimes
// 404 with an explicit "model not found / deprecated" reason); recording that
// lets the dashboard badge dead combo targets instead of re-paying for the same
// failed upstream call on every request.

export const DEPRECATION_GONE = "gone";
export const DEPRECATION_RETIRED = "retired";

// Lowercase substrings that mean "this model is gone", not "this request was
// bad". Kept narrow on purpose: a 410 about an expired device code is not a
// deprecation.
const DEPRECATION_MARKERS = [
  "model_not_found",
  "model not found",
  "unknown model",
  "no such model",
  "model_deactivated",
  "model is deprecated",
  "model deprecated",
  "deprecated_model",
  "model_retired",
  "model has been retired",
  "model is no longer available",
  "model no longer exists",
  "unsupported model",
  "invalid model id",
];

// "<provider>/<model>", lowercased: a combo entry, a connection row and a
// dashboard query do not always agree on case.
export function deprecationKey(provider, model) {
  return `${String(provider || "").toLowerCase()}/${String(model || "").toLowerCase()}`;
}

function decodeBody(body) {
  if (!body) return null;
  if (typeof body === "object") return body;
  const raw = String(body);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { message: raw };
  } catch {
    // The caller often only has the already-formatted error string; keep it as
    // the message so the marker scan still sees "model not found" in it.
    return { message: raw };
  }
}

function collectTokens(payload) {
  if (!payload) return "";
  const parts = [payload.type, payload.message, payload.error];
  const err = payload.error;
  if (err && typeof err === "object") {
    parts.push(err.type, err.code, err.status, err.message, err.detail);
  }
  return parts.filter((p) => typeof p === "string" || typeof p === "number").join(" ").toLowerCase();
}

function matchMarker(body) {
  const payload = decodeBody(body);
  if (!payload) return "";
  const haystack = collectTokens(payload);
  return DEPRECATION_MARKERS.find((m) => haystack.includes(m)) || "";
}

// True when the response means "upstream no longer serves this model".
export function isModelDeprecation(status, body) {
  const payload = decodeBody(body);
  const marker = matchMarker(body);
  if (marker) return true;
  // A bare 410 with no error envelope is still a Gone. A 410 that DOES carry an
  // envelope naming another reason (expired device code, expired session) is not.
  if (status === 410) return !payload || typeof payload !== "object" || !payload.error;
  return false;
}

// Best-effort message + successor model from the upstream payload.
export function parseModelDeprecation(body) {
  const payload = decodeBody(body);
  if (!payload) return { message: "", successor: "" };
  const err = payload.error && typeof payload.error === "object" ? payload.error : {};
  const message = [err.message, err.detail, payload.message].find((v) => typeof v === "string" && v) || "";
  let successor = [err.successor, err.replaced_by, err.replacement].find((v) => typeof v === "string" && v) || "";
  if (!successor && message) {
    const m = message.match(/(?:use|try|migrate to|replaced by|successor:?)\s+([\w.\-/:]+)/i);
    if (m) successor = m[1];
  }
  return { message, successor };
}
