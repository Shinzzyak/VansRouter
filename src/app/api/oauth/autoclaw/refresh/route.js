import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { refreshAutoclawToken } from "open-sse/services/tokenRefresh/autoclaw.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId query parameter is required" },
      { status: 400 }
    );
  }
  try {
    const conn = await getProviderConnectionById(connectionId);
    if (!conn || conn.provider !== "autoclaw") {
      return NextResponse.json({ error: "autoclaw connection not found" }, { status: 404 });
    }
    const tokens = await refreshAutoclawToken(conn, console, null, async (newTokens) => {
      await updateProviderConnection(connectionId, {
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresAt: newTokens.expiresAt,
        lastRefreshAt: new Date().toISOString(),
        lastError: null,
      });
    });
    return NextResponse.json({
      success: true,
      expiresAt: tokens.expiresAt,
    });
  } catch (e) {
    const status = e.recoverable ? 503 : 502;
    return NextResponse.json({ error: e.message }, { status });
  }
}
