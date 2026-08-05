// ClinePass/Cline upstream wraps non-streaming JSON responses in a {success, data} envelope
// (errors use {success: false, error}). Detect and unwrap; pass through untouched otherwise.
// Cline's upstream returns {"data":{...choices...}} for non-streaming — same shape family.

export function unwrapClinepassEnvelope(body, provider) {
  if (provider !== "clinepass" && provider !== "cline") return { body, error: null };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, error: null };

  // cline upstream: {"data":{...}} envelope (non-streaming JSON)
  if (provider === "cline" && "data" in body && body.data && typeof body.data === "object"
      && !Array.isArray(body.data) && ("choices" in body.data || "error" in body.data)) {
    return { body: body.data, error: null };
  }

  if (!("success" in body)) return { body, error: null };

  if (body.success === false) {
    const message = typeof body.error === "string"
      ? body.error
      : body.error?.message || body.message || "Upstream error";
    return { body: null, error: { message, status: body.statusCode || null } };
  }

  if (body.success === true && "data" in body && body.data !== null && typeof body.data === "object") {
    return { body: body.data, error: null };
  }

  return { body, error: null };
}
