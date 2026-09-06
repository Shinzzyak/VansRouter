// Instruction receipts — per-request record of WHICH instruction blocks were
// applied, skipped, or failed. Observability layer for instructionPlan.js:
// fail-open injectors (promptInjectors.js safe()) currently swallow errors
// silently; receipts make the pipeline auditable and feed the provider ×
// format × model eval matrix.
//
// Privacy: receipts carry block IDs, versions, hashes, and status — NEVER the
// block text, never prompt content, never secrets. Safe to log and persist.

/**
 * Create a receipt for one request.
 * @param {object} plan — from buildInstructionPlan()
 * @returns {object} receipt
 */
export function createReceipt(plan) {
  return {
    planVersion: plan?.version || null,
    createdAt: new Date().toISOString(),
    blocks: (plan?.blocks || []).map((b) => ({
      id: b.id,
      version: b.version,
      hash: b.hash,
      scope: b.scope,
      applied: !!b.applied,
      skipReason: b.skipReason || null,
      injectorStatus: null, // 'ok' | 'failed' — filled by recordInjectorResult
    })),
  };
}

/**
 * Record the outcome of one injector against a receipt block.
 * @param {object} receipt
 * @param {string} blockId
 * @param {'ok'|'failed'} status
 */
export function recordInjectorResult(receipt, blockId, status) {
  if (!receipt || !Array.isArray(receipt.blocks)) return;
  const b = receipt.blocks.find((x) => x.id === blockId);
  if (b) b.injectorStatus = status;
}

/**
 * Compact single-line summary for logs: applied IDs + skipped IDs + failures.
 * @param {object} receipt
 * @returns {string}
 */
export function summarizeReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.blocks)) return "no-plan";
  const applied = receipt.blocks.filter((b) => b.applied).map((b) => b.id);
  const skipped = receipt.blocks.filter((b) => !b.applied).map((b) => `${b.id}:${b.skipReason || "?"}`);
  const failed = receipt.blocks.filter((b) => b.injectorStatus === "failed").map((b) => b.id);
  let s = `applied=[${applied.join(",")}]`;
  if (skipped.length) s += ` skipped=[${skipped.join(",")}]`;
  if (failed.length) s += ` FAILED=[${failed.join(",")}]`;
  return s;
}
