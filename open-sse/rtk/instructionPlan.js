// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __E = loadEngine("instructionPlan") ?? {};

export const BLOCK_IDS = __E.BLOCK_IDS ?? Object.freeze({ OWNER_IDENTITY: 'owner_identity', TASK_EXECUTION: 'task_execution', GODMODE_BEHAVIOR: 'godmode_behavior', OUTPUT_CONTRACT: 'output_contract', COMPACTION_REASSERT: 'compaction_reassert', THINKING_GATE: 'thinking_gate', POTATO: 'potato' });
export const COMPACTION_REASSERT_TEXT = __E.COMPACTION_REASSERT_TEXT ?? "";
export const OUTPUT_CONTRACT_TEXT = __E.OUTPUT_CONTRACT_TEXT ?? "";
export const OWNER_IDENTITY_TEXT = __E.OWNER_IDENTITY_TEXT ?? "";
export const PLAN_VERSION = __E.PLAN_VERSION ?? "0.0";
export const POTATO_MECHANICS_TEXT = __E.POTATO_MECHANICS_TEXT ?? "";
export const TASK_EXECUTION_TEXT = __E.TASK_EXECUTION_TEXT ?? "";
export const THINKING_GATE_TEXT = __E.THINKING_GATE_TEXT ?? "";
export const buildInstructionPlan = __E.buildInstructionPlan ?? (() => ({ version: '0.0', structuredOutput: false, blocks: [], engineMissing: true }));
