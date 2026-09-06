import { describe, it, expect } from "vitest";
import { buildInstructionPlan, BLOCK_IDS, PLAN_VERSION } from "open-sse/rtk/instructionPlan.js";
import { createReceipt, recordInjectorResult, summarizeReceipt } from "open-sse/rtk/instructionReceipts.js";

describe("buildInstructionPlan", () => {
  it("always includes owner identity and task execution", () => {
    const plan = buildInstructionPlan({});
    const ids = plan.blocks.map((b) => b.id);
    expect(ids).toContain(BLOCK_IDS.OWNER_IDENTITY);
    expect(ids).toContain(BLOCK_IDS.TASK_EXECUTION);
    expect(ids).toContain(BLOCK_IDS.OUTPUT_CONTRACT);
    expect(plan.version).toBe(PLAN_VERSION);
  });

  it("godmode block only when enabled with text", () => {
    expect(buildInstructionPlan({ godmodeEnabled: false, godmodeText: "X" }).blocks.map((b) => b.id)).not.toContain(BLOCK_IDS.GODMODE_BEHAVIOR);
    expect(buildInstructionPlan({ godmodeEnabled: true, godmodeText: "" }).blocks.map((b) => b.id)).not.toContain(BLOCK_IDS.GODMODE_BEHAVIOR);
    expect(buildInstructionPlan({ godmodeEnabled: true, godmodeText: "GOD" }).blocks.map((b) => b.id)).toContain(BLOCK_IDS.GODMODE_BEHAVIOR);
  });

  it("compaction block only when handoff present", () => {
    expect(buildInstructionPlan({ hasCompaction: false }).blocks.map((b) => b.id)).not.toContain(BLOCK_IDS.COMPACTION_REASSERT);
    expect(buildInstructionPlan({ hasCompaction: true }).blocks.map((b) => b.id)).toContain(BLOCK_IDS.COMPACTION_REASSERT);
  });

  it("structured output skips chat-targeted blocks with a reason", () => {
    const plan = buildInstructionPlan({ structuredOutput: true, godmodeEnabled: true, godmodeText: "GOD" });
    const god = plan.blocks.find((b) => b.id === BLOCK_IDS.GODMODE_BEHAVIOR);
    const contract = plan.blocks.find((b) => b.id === BLOCK_IDS.OUTPUT_CONTRACT);
    const identity = plan.blocks.find((b) => b.id === BLOCK_IDS.OWNER_IDENTITY);
    expect(god.applied).toBe(false);
    expect(god.skipReason).toBe("target_mismatch");
    expect(contract.applied).toBe(false);
    expect(identity.applied).toBe(true);
  });

  it("hashes are stable and distinct per block", () => {
    const p1 = buildInstructionPlan({});
    const p2 = buildInstructionPlan({});
    const id1 = p1.blocks.find((b) => b.id === BLOCK_IDS.OWNER_IDENTITY);
    const id2 = p2.blocks.find((b) => b.id === BLOCK_IDS.OWNER_IDENTITY);
    expect(id1.hash).toBe(id2.hash);
    expect(id1.hash).toHaveLength(16);
    const hashes = new Set(p1.blocks.map((b) => b.hash));
    expect(hashes.size).toBe(p1.blocks.length);
  });
});

describe("receipts", () => {
  it("records blocks without leaking text", () => {
    const plan = buildInstructionPlan({ godmodeEnabled: true, godmodeText: "SECRET_GODMODE_TEXT" });
    const receipt = createReceipt(plan);
    const json = JSON.stringify(receipt);
    expect(json).not.toContain("SECRET_GODMODE_TEXT");
    expect(receipt.blocks.length).toBe(plan.blocks.length);
    expect(receipt.blocks[0]).toHaveProperty("hash");
  });

  it("records injector results and summarizes", () => {
    const plan = buildInstructionPlan({ hasCompaction: true });
    const receipt = createReceipt(plan);
    recordInjectorResult(receipt, BLOCK_IDS.OWNER_IDENTITY, "ok");
    recordInjectorResult(receipt, BLOCK_IDS.COMPACTION_REASSERT, "failed");
    const s = summarizeReceipt(receipt);
    expect(s).toContain(BLOCK_IDS.OWNER_IDENTITY);
    expect(s).toContain("FAILED=[compaction_reassert]");
  });

  it("tolerates garbage", () => {
    expect(summarizeReceipt(null)).toBe("no-plan");
    expect(() => recordInjectorResult(null, "x", "ok")).not.toThrow();
  });
});
