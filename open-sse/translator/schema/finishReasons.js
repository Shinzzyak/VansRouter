// Finish/stop reason enums. Pure data — mapping LOGIC lives in concerns/finishReason.js.

// OpenAI finish_reason values (the hub format; shared across all response translators).
export const OPENAI_FINISH = {
  STOP: "stop",
  LENGTH: "length",
  TOOL_CALLS: "tool_calls",
  CONTENT_FILTER: "content_filter",
  // Terminal failure surfaced by an executor that detected a dead upstream
  // stream (no semantic output). Outside the chat-completions spec, but a
  // client that receives it knows the turn failed, not that it ended cleanly.
  ERROR: "error",
};

// Claude stop_reason values.
export const CLAUDE_STOP = {
  END_TURN: "end_turn",
  MAX_TOKENS: "max_tokens",
  TOOL_USE: "tool_use",
  STOP_SEQUENCE: "stop_sequence",
  // Claude returns `refusal` when its own safety layer declines the turn. It is a
  // policy verdict and must reach the client as `content_filter`, not `stop`: a
  // client (and our own refusal metrics) branching on stop_reason otherwise reads
  // a refusal as a completed answer.
  REFUSAL: "refusal",
};

// Gemini finishReason values.
export const GEMINI_FINISH = {
  STOP: "STOP",
  MAX_TOKENS: "MAX_TOKENS",
  SAFETY: "SAFETY",
  RECITATION: "RECITATION",
  BLOCKLIST: "BLOCKLIST",
  PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
};
