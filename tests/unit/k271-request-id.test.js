import { describe, it, expect } from "vitest";
import { inboundRequestId, withRequestId, REQUEST_ID_HEADER } from "@/lib/requestId.js";

const req = (headers = {}) => ({ headers: new Headers(headers) });

describe("K271 request id", () => {
  it("echoes an inbound x-request-id so the client sees its own value", () => {
    expect(inboundRequestId(req({ "x-request-id": "abc-123" }))).toBe("abc-123");
  });

  it("falls back to x-correlation-id", () => {
    expect(inboundRequestId(req({ "x-correlation-id": "corr.9" }))).toBe("corr.9");
  });

  it("generates a uuid when the client sent none", () => {
    expect(inboundRequestId(req())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a header that could break the response", () => {
    // The fetch Headers class refuses to build with CR/LF, so a lax implementation
    // (or a proxied request object) is simulated directly.
    const lax = { headers: { get: () => 'x"\r\ninjected: 1' } };
    const bad = inboundRequestId(lax);
    expect(bad).not.toContain("\n");
    expect(bad).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stamps the header and exposes it to browser clients", () => {
    const out = withRequestId(new Response("hi", { status: 200 }), "rid-1");
    expect(out.status).toBe(200);
    expect(out.headers.get(REQUEST_ID_HEADER)).toBe("rid-1");
    expect(out.headers.get("access-control-expose-headers")).toContain(REQUEST_ID_HEADER);
  });

  it("keeps the streaming body intact", async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); c.close(); },
    });
    const out = withRequestId(new Response(stream, { status: 200 }), "rid-2");
    expect(await out.text()).toBe("data: {}\n\n");
  });
});
