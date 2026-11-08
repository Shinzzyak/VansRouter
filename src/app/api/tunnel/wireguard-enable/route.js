import { NextResponse } from "next/server";
import { startWireguard, readConf, listProfiles } from "@/lib/tunnel";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const profileName = String(body?.profileName || "").trim();
    // Validate early so a bad name never reaches the manager's sudo path.
    if (!profileName) {
      const profiles = await listProfiles();
      return NextResponse.json({ error: "Missing profileName.", profiles }, { status: 400 });
    }
    await readConf(profileName); // throws on invalid name / missing conf
    const result = await startWireguard(profileName);
    return NextResponse.json(result);
  } catch (error) {
    console.error("WireGuard enable error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const config = { runtime: "nodejs" };
