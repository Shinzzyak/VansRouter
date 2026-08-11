import { describe, it, expect } from "vitest";

import { getCompactAdapterModel, getRoleAdapterModel } from "../../open-sse/services/capacityAdapter.js";

describe("compact adapter", () => {
  it("returns null when compact pool is not configured", () => {
    expect(getCompactAdapterModel({})).toBeNull();
    expect(getCompactAdapterModel({ capacityAdapter: {} })).toBeNull();
  });

  it("returns first model when compact pool is enabled", () => {
    const settings = {
      capacityAdapter: {
        compact: { enabled: true, roundRobin: false, models: ["p/compactor", "p/other"] },
      },
    };
    expect(getCompactAdapterModel(settings)).toBe("p/compactor");
  });

  it("returns null when compact pool is disabled", () => {
    const settings = {
      capacityAdapter: {
        compact: { enabled: false, roundRobin: false, models: ["p/compactor"] },
      },
    };
    expect(getCompactAdapterModel(settings)).toBeNull();
  });

  it("reuses role adapter resolution (thinking/execution/compact)", () => {
    const settings = {
      capacityAdapter: {
        thinking: { enabled: true, roundRobin: false, models: ["p/think"] },
        execution: { enabled: true, roundRobin: false, models: ["p/exec"] },
        compact: { enabled: true, roundRobin: false, models: ["p/compact"] },
      },
    };
    expect(getRoleAdapterModel("thinking", settings)).toBe("p/think");
    expect(getRoleAdapterModel("execution", settings)).toBe("p/exec");
    expect(getCompactAdapterModel(settings)).toBe("p/compact");
  });
});
