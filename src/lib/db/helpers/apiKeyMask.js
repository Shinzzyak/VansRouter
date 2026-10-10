// Masked API-key display, mirroring 9router-go's keikey.Mask so both routers
// render a key identically: "sk-a…wxyz". Anything at or below the reveal
// threshold collapses to "***" so a short key leaks no useful entropy.
const MASK_PREFIX_LEN = 4;
const MASK_SUFFIX_LEN = 4;
const MASK_MIN_LEN = 12;

export const MASKED_UNKNOWN = "***";

export function maskApiKey(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length <= MASK_MIN_LEN) return MASKED_UNKNOWN;
  return `${plaintext.slice(0, MASK_PREFIX_LEN)}…${plaintext.slice(-MASK_SUFFIX_LEN)}`;
}
