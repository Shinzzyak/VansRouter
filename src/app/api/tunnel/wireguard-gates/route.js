import { NextResponse } from "next/server";
import { getGatesStatus, listGates, provisionGates, teardownGates } from "@/lib/tunnel";

// Per-pool WireGuard egress gates (ops/wg-socks-gate.sh).
// GET  → inventory: gates (name/port/uid/socksUrl/up) + conf/script presence.
// POST → { action: "up" | "down" } provision or tear down every gate.
// Additive infra; never returns conf bodies, keys, or tunnel internals.
export async function GET() {
  try {
    return NextResponse.json(await getGatesStatus());
  } catch (error) {
    console.error("WireGuard gates status error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "").toLowerCase();
    if (action === "up") {
      const res = await provisionGates();
      return NextResponse.json({ ...res, gates: await listGates() });
    }
    if (action === "down") {
      const res = await teardownGates();
      return NextResponse.json({ ...res, gates: await listGates() });
    }
    return NextResponse.json({ error: "action must be 'up' or 'down'" }, { status: 400 });
  } catch (error) {
    console.error("WireGuard gates action error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const config = { runtime: "nodejs" };
