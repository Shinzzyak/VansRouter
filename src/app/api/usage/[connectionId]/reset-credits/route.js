// go-parity URL for the Codex rate-limit reset credit listing. Same handler as
// /api/usage/<id>/codex-reset-credits — one implementation, two paths, so a
// client written against either name talks to the same code.
export { GET } from "../codex-reset-credits/route.js";

export const dynamic = "force-dynamic";
