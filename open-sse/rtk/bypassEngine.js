// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("bypassEngine") ?? {};

export const BYPASS_MODES = __E.BYPASS_MODES ?? Object.freeze({ OFF: 'off', FRAMING: 'framing', AGGRESSIVE: 'aggressive' });
export const appendEscalationToBody = __E.appendEscalationToBody ?? ((body) => body);
export const applyBypass = __E.applyBypass ?? ((body) => body);
export const buildBypassLog = __E.buildBypassLog ?? (() => "");
export const buildEmptyResponseEscalation = __E.buildEmptyResponseEscalation ?? (() => null);
export const classifyStreamHead = __E.classifyStreamHead ?? (() => null);
export const detectGeminiGuardrailRefusal = __E.detectGeminiGuardrailRefusal ?? (() => false);
export const detectModelFamily = __E.detectModelFamily ?? (() => null);
export const detectRefusal = __E.detectRefusal ?? (() => false);
export const extractProviderPrefix = __E.extractProviderPrefix ?? ((m) => m);
export const getEscalationPrompt = __E.getEscalationPrompt ?? (() => null);
export const getFramingStrategy = __E.getFramingStrategy ?? (() => null);
export const isContentSafetyRejected = __E.isContentSafetyRejected ?? (() => false);
export const isOutputFiltered = __E.isOutputFiltered ?? (() => false);
export const peekStreamForRefusal = __E.peekStreamForRefusal ?? (async () => null);
export const reconstructPeekedStream = __E.reconstructPeekedStream ?? (() => null);
export const stripProviderPrefix = __E.stripProviderPrefix ?? ((m) => m);
