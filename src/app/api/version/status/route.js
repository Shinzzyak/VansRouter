// GET /api/version/status — 9router-go parity alias for the version route.
// One implementation, two URLs: re-exported rather than copied so the numbers
// can never drift between them.
export { GET, dynamic } from "../route.js";
