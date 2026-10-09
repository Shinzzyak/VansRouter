import { describe, it, expect } from "vitest";
import { stripModelContextMarker } from "../../open-sse/utils/modelMarkers.js";

const BARE = "test-model-1";

describe("stripModelContextMarker", () => {
  it("strips the trailing [1m] beta marker and reports it", () => {
    expect(stripModelContextMarker(`${BARE}[1m]`)).toEqual({
      model: BARE,
      contextMarker: "1m",
    });
  });

  it("is case-insensitive on the marker", () => {
    expect(stripModelContextMarker(`${BARE}[1M]`)).toEqual({
      model: BARE,
      contextMarker: "1m",
    });
  });

  it("tolerates surrounding whitespace and returns the trimmed id", () => {
    expect(stripModelContextMarker(`  ${BARE}[1m]  `)).toEqual({
      model: BARE,
      contextMarker: "1m",
    });
  });

  it("leaves a model without a marker untouched, whitespace and all", () => {
    expect(stripModelContextMarker(BARE)).toEqual({
      model: BARE,
      contextMarker: null,
    });
    expect(stripModelContextMarker(` ${BARE} `)).toEqual({
      model: ` ${BARE} `,
      contextMarker: null,
    });
  });

  it("does not eat a marker-like segment in the middle of an id", () => {
    expect(stripModelContextMarker("claude[1m]-sonnet").contextMarker).toBeNull();
  });

  it("only strips the trailing marker, not every bracket", () => {
    expect(stripModelContextMarker("[1m][1m]").model).toBe("[1m]");
  });

  it("passes non-string input through unharmed", () => {
    expect(stripModelContextMarker(undefined)).toEqual({ model: undefined, contextMarker: null });
    expect(stripModelContextMarker(null)).toEqual({ model: null, contextMarker: null });
  });

  it("strips a bare marker to an empty id rather than crashing", () => {
    expect(stripModelContextMarker("[1m]")).toEqual({ model: "", contextMarker: "1m" });
  });
});
