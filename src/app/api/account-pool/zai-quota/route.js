import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Proxy ke ZAI sidecar /quota (in-process cache 5 menit di sidecar — instant).
export async function GET() {
  try {
    const r = await fetch("http://127.0.0.1:8879/quota", { cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json({ error: `sidecar ${r.status}` }, { status: 502 });
    }
    return NextResponse.json(await r.json());
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
