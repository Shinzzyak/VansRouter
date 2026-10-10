import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { vaultCounts } from "@/lib/vault/status.js";

export const dynamic = "force-dynamic";

// GET /api/vault/status
//
// `plaintextCount > 0` with `enabled: true` means credentials exist that were
// written before the vault was switched on — they stay readable, and the next
// write through the repo seals them.
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await vaultCounts());
  } catch (error) {
    console.log("Error reading vault status:", error);
    return NextResponse.json({ error: "Failed to read vault status" }, { status: 500 });
  }
}
