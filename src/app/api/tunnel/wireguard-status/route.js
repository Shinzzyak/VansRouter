import { NextResponse } from "next/server";
import { getWireguardStatus } from "@/lib/tunnel";

export async function GET() {
  try {
    const status = await getWireguardStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("WireGuard status error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const config = { runtime: "nodejs" };
