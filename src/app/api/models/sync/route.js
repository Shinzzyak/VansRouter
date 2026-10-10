// POST /api/models/sync — 9router-go URL shape for "refresh the model catalog
// now". Re-exported from the catalog-sync handler so both URLs run the same
// sync: one implementation, so a sync triggered from either place reports the
// same result.
export { GET, POST, dynamic } from "../catalog-sync/route.js";
