// Live gate: the seeded OpenCode roster must be a subset of the live roster.
// Run manually — it needs the network, so it is deliberately not in the vitest
// glob (same contract as tests/opencode-zen-gate.live.mjs).
//
//   node tests/opencode-roster-drift.live.mjs
//
// Exit 0 = every seed id still exists upstream. Exit 1 = at least one seed id
// vanished (a dead route in the picker). Exit 2 = the roster could not be read,
// which is NOT a pass — a fetch failure must never look green.
import registry from "../open-sse/providers/registry/opencode.js";

const ROSTER_URL = registry.modelsFetcher?.url;
if (!ROSTER_URL) {
  console.error("registry.modelsFetcher.url missing");
  process.exit(2);
}

const UA = "opencode/latest/2.0.26/cli";

let live;
try {
  const res = await fetch(ROSTER_URL, { headers: { "User-Agent": UA, "x-opencode-client": "cli" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  live = new Set((json.data ?? json.models ?? []).map((m) => m?.id).filter(Boolean));
} catch (e) {
  console.error(`roster fetch failed: ${e.message}`);
  process.exit(2);
}

// Only ids the fetcher can return matter for drift: the fetcher keeps the
// `-free` suffix plus the explicitly non-chat models. A seed id outside that
// set is a declaration, not a route, so it is checked but reported separately.
const isFetched = (id) => id.endsWith("-free") || id === "big-pickle";

const seeded = registry.models.map((m) => m.id);
const dead = seeded.filter((id) => !live.has(id));
const freeLive = [...live].filter((id) => id.endsWith("-free")).sort();
const missingFromSeed = freeLive.filter((id) => !seeded.includes(id));

console.log(`live roster: ${live.size} ids`);
console.log(`seeded:      ${seeded.length} ids`);
console.log(`live free:   ${freeLive.length} ids`);

if (missingFromSeed.length) {
  console.log(`\nnew upstream, not seeded (seed only covers fetch failure):`);
  for (const id of missingFromSeed) console.log(`  + ${id}`);
}

if (dead.length) {
  console.log(`\nDEAD SEEDS — present in the registry, gone upstream:`);
  for (const id of dead) console.log(`  - ${id}${isFetched(id) ? "  (fetched id — dead route)" : "  (declaration)"}`);
  process.exit(1);
}

console.log("\nseed ⊆ live: OK");
