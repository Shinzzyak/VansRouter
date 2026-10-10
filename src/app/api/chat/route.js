// POST /api/chat — 9router-go URL shape for the Ollama-style chat endpoint.
// Re-exported from /api/v1/api/chat: the transform and the handler are the same
// code, so the two URLs cannot drift.
export { POST, OPTIONS } from "../v1/api/chat/route.js";
