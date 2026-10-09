// Guardrail detectors.
//
// Every detector is shape-then-validate: a cheap regex proposes candidates and a
// checksum decides. That two-step is what makes the set usable on this gateway's
// traffic, which is overwhelmingly source code — a bare /\b\d{16}\b/ would fire
// on every git SHA in a diff, so the sixteen-digit rule is gated on Luhn and the
// email rule demands a real TLD.
//
// Ported from 9router-go internal/guardrails/detectors.go. The patterns are the
// contract: a looser regex here means redacting a customer's source code.

export const REDACT_MASK = "[REDACTED]";

export const SEVERITY = { low: 1, medium: 2, high: 3 };

/**
 * Luhn checksum. Validates card numbers and Indonesian NIK alike, and is the
 * only thing separating a real account number from the git SHA that shares its
 * shape. Non-digits are skipped so grouped numbers ("4111 1111 1111 1111")
 * validate.
 */
function luhn(value) {
  let sum = 0;
  let digits = 0;
  let double = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) continue;
    digits += 1;
    let n = code - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    double = !double;
    sum += n;
  }
  if (digits < 12) return false;
  return sum % 10 === 0;
}

/** IBAN mod-97. The number carries its own check digits, so this test is exact. */
function validIban(value) {
  const rearranged = value.slice(4) + value.slice(0, 4);
  let sum = 0;
  for (const ch of rearranged) {
    if (ch >= "0" && ch <= "9") {
      sum = sum * 10 + (ch.charCodeAt(0) - 48);
    } else if (ch >= "A" && ch <= "Z") {
      sum = sum * 100 + (ch.charCodeAt(0) - 65 + 10);
    } else {
      return false;
    }
    sum %= 97;
  }
  return sum === 1;
}

/**
 * Only globally routable IPv4 counts as personal data. Loopback, private and
 * link-local addresses are infrastructure: this gateway's traffic is full of
 * docker-compose files and server configs, and flagging those breaks real work.
 */
function isPublicIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets;
  if (a === 0 || a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

// TLD anchored on the real list: `user@example.com` appears in READMEs and
// fixtures constantly, and a loose local-part match would redact documentation.
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.(?:com|net|org|io|ai|co|dev|id|jp|de|uk|us|nl|fr|br|in|ca|au|sg|my)\b/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const NIK_RE = /\b\d{16}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

// An instruction to discard the system prompt, in every phrasing around it.
const IGNORE_PREVIOUS_RE =
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|earlier|above|preceding|all)\b[^.\n]{0,40}\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions|context)\b/gi;
// Reopening the system role, e.g. "you are now ...".
const ROLE_OVERRIDE_RE =
  /\byou\s+are\s+(?:now|no\s+longer)\b|\bact\s+as\s+(?:if\s+you\s+(?:are|were)|a\s+(?:different|new)|without)\b|\bsystem\s*prompt\s*(?:override|replacement)\b/gi;
// Named jailbreak personas.
const JAILBREAK_PERSONA_RE = /\b(?:DAN|do\s+anything\s+now|developer\s+mode|jailbreak|unfiltered\s+mode)\b/gi;
// Asking the model to print its own instructions.
const SYSTEM_LEAK_RE =
  /\b(?:repeat|print|output|show|reveal|display|echo)\b[^.\n]{0,40}\b(?:your\s+)?(?:initial|system|original)\s+(?:instruction|instructions|prompt|prompts)\b/gi;
// Explicit safety-off phrasing. The verb must be genuinely imperative: start of
// text, after sentence punctuation, or introduced by please/now/then. A bare
// newline is deliberately NOT an anchor — every source file in this traffic
// begins lines with verbs ("bypass := safety.filter(v)"), and treating those as
// an attack would block ordinary development.
const SAFETY_BYPASS_RE =
  /(?:^|[.!?;]\s*|\b(?:please|now|then)\s+)\b(?:bypass|disable|turn\s+off|circumvent|remove)\b[^.\n]{0,30}\b(?:safety|filter|filters|guardrail|guardrails|restriction|restrictions|content\s+polic\w*|moderation)\b/gi;

const PII_DETECTORS = [
  { name: "email", re: EMAIL_RE, entity: "EMAIL_ADDRESS", severity: SEVERITY.medium },
  { name: "ipv4", re: IPV4_RE, entity: "IP_ADDRESS", severity: SEVERITY.low, validate: isPublicIpv4 },
  { name: "id_nik", re: NIK_RE, entity: "ID_NIK", severity: SEVERITY.high, validate: luhn },
  { name: "credit_card", re: CARD_RE, entity: "CREDIT_CARD", severity: SEVERITY.high, validate: luhn },
  { name: "iban", re: IBAN_RE, entity: "IBAN", severity: SEVERITY.high, validate: validIban },
];

const INJECTION_DETECTORS = [
  { name: "ignore_previous", re: IGNORE_PREVIOUS_RE, entity: "PROMPT_INJECTION", severity: SEVERITY.high },
  { name: "role_override", re: ROLE_OVERRIDE_RE, entity: "PROMPT_INJECTION", severity: SEVERITY.medium },
  { name: "jailbreak_persona", re: JAILBREAK_PERSONA_RE, entity: "JAILBREAK", severity: SEVERITY.high },
  { name: "system_leak", re: SYSTEM_LEAK_RE, entity: "SYSTEM_PROMPT_LEAK", severity: SEVERITY.high },
  { name: "safety_bypass", re: SAFETY_BYPASS_RE, entity: "SAFETY_BYPASS", severity: SEVERITY.high },
];

/** Detector set names a policy may enable. Anything else is ignored, not guessed. */
export const DETECTOR_SETS = {
  pii: PII_DETECTORS,
  injection: INJECTION_DETECTORS,
};

/**
 * Runs one detector set over text and returns its findings in match order.
 * A shared regex is stateful via lastIndex, so every scan rewinds first.
 */
export function runDetectors(detectors, text) {
  const findings = [];
  for (const detector of detectors) {
    detector.re.lastIndex = 0;
    let match;
    while ((match = detector.re.exec(text)) !== null) {
      if (match[0] === "") {
        detector.re.lastIndex += 1;
        continue;
      }
      if (detector.validate && !detector.validate(match[0])) continue;
      findings.push({
        detector: detector.name,
        entity: detector.entity,
        start: match.index,
        end: match.index + match[0].length,
        severity: detector.severity,
        redacted: REDACT_MASK,
      });
    }
  }
  return findings;
}

/**
 * The spans that are actually replaced: sorted, with overlaps resolved by
 * keeping the first and dropping any that starts inside it. Overlapping spans
 * would corrupt the offsets and duplicate or drop text.
 *
 * Shared with the outbound tap, which needs the exact replaced regions to write
 * the replacement back into the frame that carried it.
 */
export function appliedSpans(text, findings) {
  if (!findings.length) return [];
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const finding of sorted) {
    if (finding.start < cursor || finding.end > text.length || finding.start >= finding.end) continue;
    out.push({ start: finding.start, end: finding.end, redacted: finding.redacted });
    cursor = finding.end;
  }
  return out;
}

/** Rewrites text with every applied finding's span replaced. */
export function maskFindings(text, findings) {
  const spans = appliedSpans(text, findings);
  if (!spans.length) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.redacted;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
