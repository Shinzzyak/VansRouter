import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getAutoclawBalance } from "open-sse/services/usage/autoclaw.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
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
    const balance = await getAutoclawBalance(conn.accessToken, conn.providerSpecificData);
    return NextResponse.json({ success: true, ...balance });
  } catch (e) {
    const status = e.recoverable ? 503 : 502;
    return NextResponse.json({ error: e.message }, { status });
  }
}
