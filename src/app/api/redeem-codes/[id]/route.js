import { NextResponse } from "next/server";
import { deleteRedeemCode, getRedeemCodeById, revokeRedeemCode } from "@/lib/db/repos/redeemCodesRepo.js";

export const dynamic = "force-dynamic";

// GET /api/redeem-codes/[id]
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const code = await getRedeemCodeById(id);
    if (!code) {
      return NextResponse.json({ error: "Redeem code not found" }, { status: 404 });
    }
    return NextResponse.json({ code });
  } catch (error) {
    console.log("Error fetching redeem code:", error);
    return NextResponse.json({ error: "Failed to fetch redeem code" }, { status: 500 });
  }
}

// DELETE /api/redeem-codes/[id]        → revoke (keeps the row and its history)
// DELETE /api/redeem-codes/[id]?purge=1 → hard delete
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const purge = new URL(request.url).searchParams.get("purge") === "1";

    if (purge) {
      const removed = await deleteRedeemCode(id);
      if (!removed) {
        return NextResponse.json({ error: "Redeem code not found" }, { status: 404 });
      }
      return NextResponse.json({ deleted: true, id });
    }

    const revoked = await revokeRedeemCode(id);
    if (!revoked) {
      return NextResponse.json({ error: "Redeem code not found" }, { status: 404 });
    }
    return NextResponse.json({ revoked: true, code: revoked });
  } catch (error) {
    console.log("Error revoking redeem code:", error);
    return NextResponse.json({ error: "Failed to revoke redeem code" }, { status: 500 });
  }
}
