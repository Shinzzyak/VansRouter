// GENERATED SHIM — do not edit. The real implementation lives in the private
// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.
//
// Regenerate: node scripts/engine-bundle.mjs
// Undo:       node scripts/engine-bundle.mjs --restore
//
// Without the bundle this module degrades to safe no-ops so the router still
// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).
import { loadEngine } from "./engineLoader.js";

const __M = "instructionPlan";
// K228: resolve at CALL time. A const captured at import pinned whatever the
// loader saw first, so an import during a miss window got the no-ops forever.
const __g = (n, fb) => (...a) => {
  const f = loadEngine(__M)?.[n];
  return typeof f === "function" ? f(...a) : typeof fb === "function" ? fb(...a) : fb;
};

export const BLOCK_IDS = (loadEngine(__M) ?? {})["BLOCK_IDS"] ?? Object.freeze({ OWNER_IDENTITY: 'owner_identity', TASK_EXECUTION: 'task_execution', GODMODE_BEHAVIOR: 'godmode_behavior', OUTPUT_CONTRACT: 'output_contract', COMPACTION_REASSERT: 'compaction_reassert', THINKING_GATE: 'thinking_gate', POTATO: 'potato', CONTRACT_TAIL: 'contract_tail' });
export const COMPACTION_REASSERT_TEXT = (loadEngine(__M) ?? {})["COMPACTION_REASSERT_TEXT"] ?? "";
export const OUTPUT_CONTRACT_TEXT = (loadEngine(__M) ?? {})["OUTPUT_CONTRACT_TEXT"] ?? "";
export const OWNER_IDENTITY_TEXT = (loadEngine(__M) ?? {})["OWNER_IDENTITY_TEXT"] ?? "";
export const PLAN_VERSION = (loadEngine(__M) ?? {})["PLAN_VERSION"] ?? "0.0";
export const POTATO_MECHANICS_TEXT = (loadEngine(__M) ?? {})["POTATO_MECHANICS_TEXT"] ?? "";
export const TASK_EXECUTION_TEXT = (loadEngine(__M) ?? {})["TASK_EXECUTION_TEXT"] ?? "";
export const THINKING_GATE_TEXT = (loadEngine(__M) ?? {})["THINKING_GATE_TEXT"] ?? "";
export const buildInstructionPlan = __g("buildInstructionPlan", (() => ({ version: '0.0', structuredOutput: false, blocks: [], engineMissing: true })));
