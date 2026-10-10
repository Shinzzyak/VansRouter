// POST /api/models/sync — 9router-go URL shape for "refresh the model catalog
// now". Re-exported from the catalog-sync handler so both URLs run the same
// sync: one implementation, so a sync triggered from either place reports the
// same result.
//
// Handler only: Next rejects a re-exported route segment config (`dynamic`),
// and Turbopack fails the whole build over it. Neither handler needs one — POST
// handlers are dynamic by definition.
export { GET, POST } from "../catalog-sync/route.js";
