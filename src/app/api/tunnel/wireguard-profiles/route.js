import { NextResponse } from "next/server";
import { listProfiles } from "@/lib/tunnel";

export async function GET() {
  try {
    const profiles = await listProfiles();
    return NextResponse.json({ profiles });
  } catch (error) {
    console.error("WireGuard profiles error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const config = { runtime: "nodejs" };
