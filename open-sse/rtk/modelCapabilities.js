// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("modelCapabilities") ?? {};

export const classifyResponseFailure = __E.classifyResponseFailure ?? (() => 'unknown');
export const detectCapabilityFamily = __E.detectCapabilityFamily ?? (() => 'unknown');
export const getModelCapabilityProfile = __E.getModelCapabilityProfile ?? (() => ({ family: 'unknown', requestStrategy: 'persona', personaStrategy: 'use', reasoningNullContent: true }));
