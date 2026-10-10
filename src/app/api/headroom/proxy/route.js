// Bare /api/headroom/proxy (9router-go registers both the exact path and the
// wildcard). The proxy handler already treats a missing path param as the
// target root, so the two URLs share one implementation instead of drifting.
export { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } from "./[...path]/route.js";
