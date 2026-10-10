import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { rotateVault } from "@/lib/vault/rotate.js";
import { vaultEnabled } from "@/lib/vault/index.js";

export const dynamic = "force-dynamic";

// POST /api/vault/rotate  { nextMasterKey }
//
// Re-seals every stored credential under a new master key. The caller must send
// the NEW key; the running process holds the old one. Rows that cannot be
// unwrapped are reported in `skipped` and left untouched.
export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!vaultEnabled()) {
    return NextResponse.json(
      { error: "Credential vault is disabled. Set ROUTER_MASTER_KEY before rotating." },
      { status: 400 }
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const result = await rotateVault(body?.nextMasterKey || body?.masterKey);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error rotating vault:", error);
    return NextResponse.json({ error: "Failed to rotate vault" }, { status: 500 });
  }
}
