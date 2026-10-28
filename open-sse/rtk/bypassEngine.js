// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "bypassEngine";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const BYPASS_MODES = (loadEngine(__M) ?? {})["BYPASS_MODES"] ?? Object.freeze({ OFF: 'off', FRAMING: 'framing', AGGRESSIVE: 'aggressive' });
export const appendEscalationToBody = __g("appendEscalationToBody", ((body) => body));
export const applyBypass = __g("applyBypass", ((body) => body));
export const augmentSurfaceText = __g("augmentSurfaceText", ((t) => t));
export const buildBypassLog = __g("buildBypassLog", (() => ""));
export const buildEmptyResponseEscalation = __g("buildEmptyResponseEscalation", (() => null));
export const buildForeignRefusalEscalation = __g("buildForeignRefusalEscalation", (() => ''));
export const builtinFrameText = __g("builtinFrameText", (() => ''));
export const carriesToolCalls = __g("carriesToolCalls", (() => false));
export const classifyStreamHead = __g("classifyStreamHead", (() => null));
export const detectFramingMismatch = __g("detectFramingMismatch", (() => null));
export const detectGeminiGuardrailRefusal = __g("detectGeminiGuardrailRefusal", (() => false));
export const detectModelFamily = __g("detectModelFamily", (() => null));
export const detectOwnRefusal = __g("detectOwnRefusal", ((text) => Boolean(text)));
export const detectRefusal = __g("detectRefusal", (() => false));
export const explainWall = __g("explainWall", ((m) => `wall: no bundle (${m == null ? '?' : String(m)})`));
export const extractProviderPrefix = __g("extractProviderPrefix", ((m) => m));
export const flipWordOrder = __g("flipWordOrder", ((t) => t));
export const getEscalationPrompt = __g("getEscalationPrompt", (() => null));
export const getEscalationPromptForLevel = __g("getEscalationPromptForLevel", (() => null));
export const getFramingStrategy = __g("getFramingStrategy", (() => null));
export const isContentSafetyRejected = __g("isContentSafetyRejected", (() => false));
export const isFlipFrame = __g("isFlipFrame", (() => false));
export const isOutputFiltered = __g("isOutputFiltered", (() => false));
export const isSurfaceFrame = __g("isSurfaceFrame", (() => false));
export const nodesForModel = __g("nodesForModel", (() => []));
export const noteNodeVerdict = __g("noteNodeVerdict", (() => null));
export const openerRefusal = __g("openerRefusal", (() => false));
export const peekStreamForRefusal = __g("peekStreamForRefusal", (async () => null));
export const providerWallId = __g("providerWallId", ((p, m) => `${p == null ? '' : String(p)}|${m == null ? '' : String(m)}`));
export const rankNodesForModel = __g("rankNodesForModel", ((_m, providers) => (Array.isArray(providers) ? providers : [])));
export const reconstructPeekedStream = __g("reconstructPeekedStream", (() => null));
export const refusalAttributionOf = __g("refusalAttributionOf", (() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null })));
export const resetProviderWall = __g("resetProviderWall", (() => {}));
export const stripProviderPrefix = __g("stripProviderPrefix", ((m) => m));
export const wallSnapshot = __g("wallSnapshot", (() => ({})));
export const wallVerdict = __g("wallVerdict", (() => 'unknown'));
