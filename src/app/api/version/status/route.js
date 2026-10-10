// GET /api/version/status — 9router-go parity alias for the version route.
// One implementation, two URLs: re-exported rather than copied so the numbers
// can never drift between them.
//
// Only the handler is re-exported. Next forbids re-exporting route segment
// config (`dynamic` &c): it must be statically parseable in the file that owns
// the route, and a Turbopack build fails the whole build with "mustn't be
// reexported" if one is. The target declares no segment config, so there is
// nothing to mirror here — re-exporting it was the bug, not the parity.
export { GET } from "../route.js";
