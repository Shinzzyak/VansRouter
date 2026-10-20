// Initial-password policy. The old gate only asked "is INITIAL_PASSWORD set?" —
// so setting it to "123456" skipped the forced change and accepted a weak password
// from the internet. The value is what matters, not the variable's presence.
const DEFAULT_INITIAL_PASSWORD = "123456";
const PLACEHOLDER_PASSWORDS = new Set([
  "123456",
  "change-me",
  "change-me-in-production",
  "change-me-to-a-long-random-secret",
  "password",
  "changeme",
]);
const MIN_LENGTH = 12;

export function isStrongInitialPassword(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= MIN_LENGTH && !PLACEHOLDER_PASSWORDS.has(normalized.toLowerCase());
}

// null = refuse to boot with this value in production.
export function getInitialPassword(env = process.env) {
  const configured = typeof env.INITIAL_PASSWORD === "string" ? env.INITIAL_PASSWORD.trim() : "";
  if (!configured) return DEFAULT_INITIAL_PASSWORD;
  if (env.NODE_ENV !== "production") return configured;
  return isStrongInitialPassword(configured) ? configured : null;
}
