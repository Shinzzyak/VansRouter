// GET /api/version/check — 9router-go parity alias for the version route.
// Same handler as /api/version and /api/version/status: the licence-gated pack
// reports updateChannel != "npm", which is why latestVersion stays null here
// instead of advertising an install command that would overwrite this build.
//
// Handler only: Next rejects a re-exported route segment config (`dynamic`),
// and Turbopack fails the whole build over it. The target declares none.
export { GET } from "../route.js";
