import { NextResponse } from "next/server";
import { getProviderConnections, createProviderConnection } from "@/models";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// Connection-level API (9router-go parity: /api/connections).
//
// This deployment has always managed connections through /api/providers (which
// carries the provider metadata and its connections together). The upstream
// router splits them, and the split is genuinely useful for bulk work: a
// connection is the unit that holds credentials and that a test or a reorder
// acts on, independent of the provider row.
//
// Both routes read and write the same providerConnections table, so a change
// made here is visible on the provider page and vice versa.

// GET /api/connections?provider=xxx&authType=oauth
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};
    const provider = searchParams.get("provider");
    const authType = searchParams.get("authType");
    if (provider) filter.provider = provider;
    if (authType) filter.authType = authType;

    const connections = await getProviderConnections(filter);
    return NextResponse.json({ connections, total: connections.length });
  } catch (error) {
    console.error("GET /api/connections failed:", error);
    return NextResponse.json({ error: "Failed to fetch connections" }, { status: 500 });
  }
}

// POST /api/connections — create one connection.
export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body?.provider) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    const connection = await createProviderConnection(body);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    console.error("POST /api/connections failed:", error);
    return NextResponse.json({ error: "Failed to create connection" }, { status: 500 });
  }
}
