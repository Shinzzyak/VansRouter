import { NextResponse } from "next/server";
import { importProfile } from "@/lib/tunnel";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const conf = typeof body?.conf === "string" ? body.conf : "";
  if (!name || !conf) {
    return NextResponse.json({ error: "name and conf are required." }, { status: 400 });
  }
  try {
    // conf body is never echoed back; only derived, non-secret metadata: name,
    // endpoint, peer count. PrivateKey stays in the root-only dir.
    const meta = await importProfile(name, conf);
    return NextResponse.json({ success: true, name: meta.name, endpoint: meta.endpoint, peerCount: meta.peerCount });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export const config = { runtime: "nodejs" };
