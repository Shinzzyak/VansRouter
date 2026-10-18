import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

// STATIC imports, deliberately — same reason as ../state/route.js: a dynamic
// specifier survives into the built chunk as a runtime `import()` the standalone
// server cannot resolve. These are the generated shims; without the bundle they
// answer with `available:false` instead of throwing (Zero Break Guarantee).
import { isEngineLoaded } from "open-sse/rtk/engineLoader.js";
import { genomeSnapshot } from "open-sse/rtk/framingGenome.js";
import { corpusStats, corpusTail } from "open-sse/rtk/promptCorpus.js";
import { ledgerSnapshot, providerSnapshot } from "open-sse/rtk/selfMeasuringBypass.js";

/**
 * GET /api/engine/genome — the part of the engine that rewrites itself.
 *
 * K164 gave the ladder the ability to synthesize and retire its own rungs.
 * Until this route existed that genome was write-only: rungs were born, won and
 * died, and the only evidence was a log line. Two questions could not be
 * answered without a shell on the box:
 *
 *   "what has it invented for this model, and did any of it work?"
 *   "what do the preambles we keep losing to actually look like?"
 *
 * The second is the corpus (K165): samples of the system prompts we receive,
 * sampled 1-in-N and rotated at a size cap. It is OFF unless
 * VR_PROMPT_CORPUS=1 — this route reports `enabled:false` rather than pretending
 * an empty corpus means "no preambles".
 */
function read(loaded, mod, fn) {
  if (!loaded) return { available: false };
  try {
    return fn();
  } catch (err) {
    return { available: false, error: String(err?.message || err) };
  }
}

export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loaded = isEngineLoaded();

  return NextResponse.json({
    ok: true,
    capturedAt: new Date().toISOString(),
    engineLoaded: loaded,
    genome: read(loaded, "framingGenome", () => ({ ...genomeSnapshot(), available: true })),
    // The ladder's evidence, per model AND per route (K165). A table needs the
    // rows; "how many models have learned something" is not a dashboard.
    ledger: read(loaded, "selfMeasuringBypass", () => ({
      models: ledgerSnapshot(50) ?? [],
      // K167 — a wall is installed per provider, so provider evidence is a row
      // a reader needs: a fresh model behind a walled provider inherits it.
      providers: providerSnapshot(20) ?? [],
      available: true,
    })),
    corpus: read(loaded, "promptCorpus", () => ({
      ...corpusStats(),
      recent: corpusTail(20, 600),
      available: true,
    })),
  });
}
