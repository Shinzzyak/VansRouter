import { describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

const { resolveQoderCredentials } = await import("../../open-sse/services/qoderModels.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Qoder PAT exchange", () => {
  it("exchanges PAT, resolves user id, and deduplicates concurrent calls", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/jobToken/exchange")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse({ token: "jt-test", expires_in: 3600 });
      }
      if (url.endsWith("/userinfo")) return jsonResponse({ id: "user-test" });
      throw new Error(`unexpected URL: ${url}`);
    });

    const credentials = { apiKey: "pt-concurrent-test" };
    const [first, second] = await Promise.all([
      resolveQoderCredentials(credentials),
      resolveQoderCredentials(credentials),
    ]);

    expect(first.accessToken).toBe("jt-test");
    expect(first.apiKey).toBeUndefined();
    expect(first.providerSpecificData.userId).toBe("user-test");
    expect(second.accessToken).toBe("jt-test");
    // 3 calls: center exchange (rejected by this mock), legacy fallback, userinfo.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const exchangeCall = fetchMock.mock.calls.find(([url]) => /jobToken\/exchange$/.test(url));
    expect(exchangeCall).toBeTruthy();
    expect(JSON.parse(exchangeCall[1].body)).toEqual({ personal_token: "pt-concurrent-test" });
  });

  it("clears failed exchanges so a later retry can succeed", async () => {
    // Both the center exchange and its legacy fallback fail -> the whole
    // exchange rejects and no cache entry may survive.
    fetchMock.mockRejectedValueOnce(new Error("temporary failure"));
    fetchMock.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(resolveQoderCredentials({ apiKey: "pt-retry-unique" })).rejects.toThrow("temporary failure");

    // A later attempt must go back upstream (cache cleared) and succeed.
    fetchMock.mockRejectedValueOnce(new Error("center down"));
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "jt-retry", expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ userId: "user-retry" }));
    await expect(resolveQoderCredentials({ apiKey: "pt-retry-unique" })).resolves.toMatchObject({
      accessToken: "jt-retry",
      providerSpecificData: { userId: "user-retry" },
    });
  });
});
