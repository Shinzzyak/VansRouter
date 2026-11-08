import { NextResponse } from "next/server";
import { stopWireguard } from "@/lib/tunnel";

export async function POST() {
  try {
    const result = await stopWireguard();
    return NextResponse.json(result);
  } catch (error) {
    console.error("WireGuard disable error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const config = { runtime: "nodejs" };
