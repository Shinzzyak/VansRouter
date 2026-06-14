// Ponytail injector: appends the lazy-senior-dev ruleset into the system prompt
// of the final request body, just before dispatch to the provider executor.
// Reuses the format dispatcher from caveman.js so all provider shapes (OpenAI,
// Claude, Gemini/Vertex/Antigravity, Kiro) are covered identically.

import { injectSystemPrompt } from "./caveman.js";
import { PONYTAIL_PROMPTS } from "./ponytailPrompts.js";

export function injectPonytail(body, format, level) {
  const prompt = PONYTAIL_PROMPTS[level];
  if (!body || !prompt) return false;
  return injectSystemPrompt(body, format, prompt);
}
