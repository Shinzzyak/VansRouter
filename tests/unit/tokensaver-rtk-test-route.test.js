// POST /api/tokensaver/rtk/test — the route must call the REAL autodetect export.
//
// The first version imported `autodetectFilter` while the module exports
// `autoDetectFilter`. ESM named-import mismatch does not fail at lint or at
// import time in this bundler; it fails at call time with
// "(0 , y.autodetectFilter) is not a function" and the route 500s. This pins
// the call path, not just the import line.
import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/tokensaver/rtk/test/route.js";
import { autoDetectFilter } from "open-sse/rtk/autodetect.js";

function post(payload) {
  return POST(new Request("http://x/api/tokensaver/rtk/test", {
    method: "POST",
    body: JSON.stringify(payload),
  }));
}

describe("POST /api/tokensaver/rtk/test", () => {
  it("exports an autodetect function under that exact name", () => {
    expect(typeof autoDetectFilter).toBe("function");
  });

  it("autodetects a filter and reports the saving", async () => {
    const noisy = ["$ npm install", "same line", "same line", "same line", "done"].join("\n");
    const res = await post({ text: noisy });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.autodetected).toBe(true);
    expect(typeof body.filter).toBe("string");
    expect(body.filter.length).toBeGreaterThan(0);
    expect(body.bytesBefore).toBe(noisy.length);
    // The pipeline refuses to grow a body, and the route reports that decision
    // instead of pretending the filter helped: `applied` must agree with the
    // measured sizes either way (some filters legitimately grow a tiny input).
    expect(body.applied).toBe(body.bytesAfter > 0 && body.bytesAfter < body.bytesBefore);
  });

  it("applied:false when the filter would grow the input", async () => {
    const res = await post({ filter: "tree", text: "x" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(body.bytesAfter < body.bytesBefore);
  });

  it("accepts an explicit filter and 400s on an unknown one", async () => {
    const res = await post({ filter: "dedup-log", text: "a\na\na\nb" });
    expect(res.status).toBe(200);
    expect((await res.json()).autodetected).toBe(false);

    const bad = await post({ filter: "not-a-filter", text: "x" });
    expect(bad.status).toBe(400);
  });

  it("400s without text", async () => {
    expect((await post({})).status).toBe(400);
  });
});
