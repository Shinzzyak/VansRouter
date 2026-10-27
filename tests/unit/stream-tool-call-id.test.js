import { describe, it, expect } from "vitest";
import { ensureStreamToolCallIds } from "../../open-sse/utils/streamHelpers.js";

const chunk = (calls) => ({ choices: [{ index: 0, delta: { tool_calls: calls } }] });

describe("ensureStreamToolCallIds", () => {
  it("isi id yang hilang pada fragmen pertama", () => {
    const seen = new Map();
    const c = chunk([{ index: 0, function: { name: "cari", arguments: "{" } }]);
    expect(ensureStreamToolCallIds(c, seen)).toBe(true);
    expect(typeof c.choices[0].delta.tool_calls[0].id).toBe("string");
    expect(c.choices[0].delta.tool_calls[0].id.length).toBeGreaterThan(0);
  });

  it("id stabil untuk fragmen berikutnya dengan index sama", () => {
    const seen = new Map();
    const first = chunk([{ index: 0, function: { name: "cari", arguments: "{" } }]);
    ensureStreamToolCallIds(first, seen);
    const id = first.choices[0].delta.tool_calls[0].id;

    const rest = chunk([{ index: 0, function: { arguments: "\"q\":1}" } }]);
    ensureStreamToolCallIds(rest, seen);
    expect(rest.choices[0].delta.tool_calls[0].id).toBe(id);
  });

  it("id beda untuk index beda", () => {
    const seen = new Map();
    const c = chunk([
      { index: 0, function: { name: "a", arguments: "{}" } },
      { index: 1, function: { name: "b", arguments: "{}" } },
    ]);
    ensureStreamToolCallIds(c, seen);
    const [a, b] = c.choices[0].delta.tool_calls;
    expect(a.id).not.toBe(b.id);
  });

  it("id sah dari provider tidak ditimpa", () => {
    const seen = new Map();
    const c = chunk([{ index: 0, id: "call_abc123", function: { name: "x" } }]);
    expect(ensureStreamToolCallIds(c, seen)).toBe(false);
    expect(c.choices[0].delta.tool_calls[0].id).toBe("call_abc123");
    expect(seen.get(0)).toBe("call_abc123");
  });

  it("chunk tanpa tool_calls aman", () => {
    expect(ensureStreamToolCallIds({ choices: [{ delta: { content: "hi" } }] }, new Map())).toBe(false);
    expect(ensureStreamToolCallIds({}, new Map())).toBe(false);
    expect(ensureStreamToolCallIds(null, new Map())).toBe(false);
  });
});
