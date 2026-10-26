// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "recipeGenome";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const RECIPE_LIMITS = (loadEngine(__M) ?? {})["RECIPE_LIMITS"] ?? Object.freeze({ MAX_RECIPES: 0, MAX_PARTS: 0, MAX_CHAIN_TURNS: 0, MAX_PROMPT_CHARS: 0, MIN_TRIES_TO_RETIRE: 0, RETIRE_RATE: 1 });
export const adoptRecipe = __g("adoptRecipe", (() => null));
export const familyOf = __g("familyOf", (() => 'unknown'));
export const isSafeRecipePart = __g("isSafeRecipePart", (() => false));
export const noteRecipe = __g("noteRecipe", (() => {}));
export const rankedChains = __g("rankedChains", (() => []));
export const rankedRecipes = __g("rankedRecipes", (() => []));
export const recipeMode = __g("recipeMode", (() => null));
export const recipePermitted = __g("recipePermitted", (() => false));
export const recipeSnapshot = __g("recipeSnapshot", (() => ({ count: 0, cap: 0, recipes: [], available: false })));
export const registerFrameResolver = __g("registerFrameResolver", (() => {}));
export const resetRecipes = __g("resetRecipes", (() => {}));
export const resolveChain = __g("resolveChain", (() => null));
export const resolveRecipe = __g("resolveRecipe", (() => null));
export const seedRecipes = __g("seedRecipes", (() => []));
