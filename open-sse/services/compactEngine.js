/**
 * Compact engine — conversation compaction as an auto-detected capability.
 *
 * Slot `capacityAdapter.compact` only PICKED A MODEL before: the request body
 * was forwarded verbatim, so the summarizer model received a full transcript
 * with no compaction instruction at all. This module supplies the missing half:
 * recognise compaction intent from ANY client shape, rewrite the body into a
 * real summarization task, and normalise the reply back to the client's format.
 *
 * Client taxonomy (verified against real traffic, 2026-09-20):
 *   codex        — POST /v1/responses/compact, body._compact, Responses API.
 *                  Nothing to rewrite: the upstream compacts server-side, so
 *                  this module only marks the route as a compact passthrough.
 *   antigravity  — compacts LOCALLY (prompt "ON-DEMAND COMPACTION: …" + a
 *                  compact tool + an on_compaction_args lifecycle hook); never
 *                  calls a compact endpoint. Its requests are ordinary chat
 *                  completions, so it is only detected via header or a
 *                  conversation-summary instruction.
 *   hermes       — builds the summary itself (context_compressor.py) and calls
 *                  /v1/chat/completions. Detected the same way.
 *   generic      — any agentic CLI sending a long transcript plus a
 *                  summarization instruction; detected on the instruction text.
 *
 * Detection is content-based on purpose: providers and CLIs rename models and
 * endpoints freely (the whole reason this engine exists), but the SHAPE of a
 * compaction request — long history + "summarize what we did so far" — is stable.
 */

// ── Detection thresholds ──────────────────────────────────────────────────────
const MIN_MESSAGES = 6;        // below this there is nothing worth compacting
const MIN_BODY_CHARS = 8000;   // ~2k tokens; shorter transcripts aren't worth a round-trip
const SCAN_TAIL = 8;           // instruction lives in the last few turns

// Instruction markers across ecosystems. Deliberately multilingual and
// bilingual-tolerant: Antigravity ships English, Hermes profiles run Indonesian.
const INSTRUCTION_MARKERS = [
  "on-demand compaction",
  "compact the conversation",
  "compact this conversation",
  "compaction",
  "summarize the conversation",
  "summarise the conversation",
  "summarize the context",
  "summarise the context",
  "summarize our conversation",
  "summarize what we did",
  "summarize the session",
  "conversation summary",
  "context summary",
  "condense the conversation",
  "compress the context",
  "ringkas percakapan",
  "ringkas konteks",
  "ringkas sesi",
  "rangkum percakapan",
];

// Explicit protocol signals beat content heuristics — a client that can set a
// header gets a deterministic route instead of a guess.
const HINT_HEADERS = ["x-vansroute-task", "x-compact", "x-task"];

const TASK_TOKENS = new Set(["compact", "compaction", "summarize", "summarise", "summary"]);

// Response wrapper every CLI understands, keyed by the CLI family we detected.
// The summary itself is never dressed up beyond these envelopes.
function envelope(kind, summary, usage) {
  if (kind === "codex") {
    return { id: `cmp_${Date.now()}`, object: "response.compaction", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] }], usage };
  }
  return null; // chat-shaped clients get the plain chat envelope from the pipeline
}

// ── Prompt ────────────────────────────────────────────────────────────────────

// Compaction system prompt. Rules mirror what production compressors converge on
// (Hermes' context_compressor.py, Antigravity's on-demand prompt): preserve
// decisions and identifiers, drop the conversational filler, never invent.
export const COMPACT_SYSTEM_PROMPT = [
  "You are a conversation compaction engine. Rewrite the message history into a dense, self-contained briefing that another agent can resume from with zero loss of operative context.",
  "",
  "Preserve, verbatim where they appear:",
  "- file paths, function/class/variable names, CLI commands, flags, env vars",
  "- model ids, provider ids, endpoint URLs, ports, hostnames, API/route names",
  "- errors and stack traces (the message text, not the whole frame dump)",
  "- decisions made and the reason they were made; options explicitly rejected and why",
  "- open questions, blockers, and anything the user asked for that is still unfinished",
  "- user constraints, preferences, bans and standing rules stated across the session",
  "",
  "Compress away:",
  "- greetings, acknowledgements, restatements of what was just said",
  "- intermediate reasoning that led nowhere, failed attempts already superseded",
  "- tool output already summarized by the history itself",
  "",
  "Output format — markdown, in this order, skipping a section only when genuinely empty:",
  "## Task",
  "## Decisions",
  "## Findings",
  "## Artifacts (paths, commands, ids)",
  "## Open Items",
  "",
  "Hard rules:",
  "- Do NOT invent anything not present in the history.",
  "- Do NOT answer the conversation's underlying request; you are summarizing, not continuing.",
  "- Do NOT add a preamble, apology, or closing offer. Start at the first heading.",
  "- Keep every identifier exact — a renamed path is a lost session.",
].join("\n");

const COMPACT_USER_INSTRUCTION =
  "Compact the conversation above into the briefing format from your instructions. " +
  "Follow any user instruction about what to focus on, and obey any explicit length limit.";

// ── Body shapes ───────────────────────────────────────────────────────────────

// Find the message array without assuming the wire format. Clients rename this
// constantly: OpenAI uses messages, Responses uses input, Vertex uses contents.
function historyKey(body) {
  if (Array.isArray(body?.messages)) return "messages";
  if (Array.isArray(body?.input)) return "input";
  if (Array.isArray(body?.contents)) return "contents";
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b?.text ?? b?.content ?? "")).join("\n");
  }
  return "";
}

function bodyCharCount(body) {
  const key = historyKey(body);
  if (!key) return 0;
  return body[key].reduce((sum, m) => sum + textOf(m?.content ?? m?.parts).length + 20, 0);
}

// Recent instruction text only — an old "let's compact later" must not trip detection.
function recentInstructionText(body, maxMessages) {
  const key = historyKey(body);
  if (!key) return "";
  const arr = body[key];
  const limit = maxMessages ?? SCAN_TAIL;
  return arr.slice(-limit).map((m) => textOf(m?.content ?? m?.parts)).join("\n").toLowerCase();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the client's explicit compaction hint from headers.
 * @returns {boolean} true when the client declared a compact task
 */
export function compactHintFromHeaders(headers) {
  if (!headers?.get) return false;
  for (const h of HINT_HEADERS) {
    const raw = headers.get(h);
    if (!raw) continue;
    const v = String(raw).toLowerCase().trim();
    if (v.includes("compact") || TASK_TOKENS.has(v)) return true;
  }
  return false;
}

/**
 * Decide whether a request is a compaction request, and which client family sent it.
 *
 * @param {object} body            parsed request body (any wire format)
 * @param {Headers|null} headers   request headers, for explicit routing hints
 * @returns {{compact: boolean, kind: string, via: string}}
 *          kind: "codex" | "antigravity" | "hermes" | "generic"
 *          via:  how it was detected — "flag" | "header" | "instruction"
 */
export function detectCompactRequest(body, headers) {
  // 1. Protocol flag — the compact endpoint or Codex's own flag. Highest trust.
  if (body?._compact === true || body?._isCompact === true) {
    return { compact: true, kind: "codex", via: "flag" };
  }

  // 2. Explicit header — deterministic opt-in for clients we cannot shape-match.
  if (compactHintFromHeaders(headers)) {
    // Antigravity and Hermes both arrive as ordinary chat completions; only the
    // header tells them apart, and only for a client configured to send one.
    return { compact: true, kind: classifyByShape(body), via: "header" };
  }

  // 3. Content heuristic — long history plus a summarization instruction in the
  //    tail. Both conditions are required so a long ordinary session is not
  //    hijacked into a summary.
  if (bodyCharCount(body) < MIN_BODY_CHARS) return { compact: false, kind: "", via: "" };
  const key = historyKey(body);
  if (!key || body[key].length < MIN_MESSAGES) return { compact: false, kind: "", via: "" };

  const tail = recentInstructionText(body);
  if (INSTRUCTION_MARKERS.some((mk) => tail.includes(mk))) {
    return { compact: true, kind: classifyByShape(body), via: "instruction" };
  }

  return { compact: false, kind: "", via: "" };
}

// Best-effort client family for chat-shaped compaction. Used only to label the
// response envelope and for observability — never to change the prompt, since
// the compaction task is identical for every client.
function classifyByShape(body) {
  const ua = String(body?.metadata?.user_agent ?? body?.userAgent ?? "").toLowerCase();
  if (ua.includes("antigravity") || ua.includes("agy")) return "antigravity";
  if (ua.includes("hermes")) return "hermes";
  if (body?.metadata?.compaction_threshold !== undefined) return "antigravity";
  return "generic";
}

/**
 * Rewrite a chat-shaped compaction request into a real summarization task.
 *
 * The history is preserved as-is (the summarizer needs it) and the instruction
 * is appended as the final user turn. When the client already supplied its own
 * compaction prompt we keep it and only add the response-shaping preamble, so a
 * client that asks for a specific format still gets it.
 *
 * @returns {object} new body — the input is not mutated
 */
export function buildCompactBody(body, kind = "generic") {
  const key = historyKey(body);
  if (!key) return body; // nothing recognizable; let the normal pipeline pass it through

  const original = body[key];
  const alreadyInstructed = INSTRUCTION_MARKERS.some((mk) => textOf(original.at(-1)?.content ?? original.at(-1)?.parts).toLowerCase().includes(mk));

  const systemMsg = { role: "system", content: COMPACT_SYSTEM_PROMPT };
  const instructionMsg = { role: "user", content: COMPACT_USER_INSTRUCTION };

  // Drop an existing system/developer turn from the history so the compaction
  // contract is not fighting the client's own system prompt for priority.
  const history = original.filter((m) => m?.role !== "system" && m?.role !== "developer");

  const next = {
    ...body,
    [key]: [systemMsg, ...history, ...(alreadyInstructed ? [] : [instructionMsg])],
    // Summaries are long and must not be truncated mid-identifier: raise the
    // ceiling when the client left it low, never lower a client's own value.
    max_tokens: Math.max(body.max_tokens ?? 0, 8192),
  };

  // Streaming compaction confuses clients that expect one finished summary
  // (a half-summary is worse than none). Force the non-stream path.
  if (next.stream === true) next.stream = false;

  // Compaction is a pure summarization task: tool use would derail it.
  delete next.tools;
  delete next.tool_choice;
  delete next.tool_config;

  return next;
}

/**
 * Normalise a completed summary back to the client's expected shape.
 * Chat-shaped clients already receive a valid chat completion from the
 * pipeline — this only strips a stray reasoning block and reports usage.
 *
 * @param {string} summary
 * @param {string} kind
 * @param {object|null} usage
 * @returns {object|null} envelope for non-chat clients, null to pass through
 */
export function wrapCompactResponse(summary, kind, usage = null) {
  return envelope(kind, summary, usage);
}
