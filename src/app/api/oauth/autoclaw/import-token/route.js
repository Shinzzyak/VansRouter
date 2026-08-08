import { NextResponse } from "next/server";
import { createProviderConnection } from "@/lib/localDb";
import { getAutoclawBalance } from "open-sse/services/usage/autoclaw.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { accessToken, refreshToken, deviceId } = body;

  if (!accessToken || !refreshToken) {
    return NextResponse.json(
      { error: "accessToken and refreshToken are required" },
      { status: 400 }
    );
  }

  try {
    const token = String(accessToken).trim();
    const device = deviceId || crypto.randomUUID();

    // Validate via user-profile (throws on bad token)
    let profile;
    try {
      const res = await fetch("https://autoglm-api.autoglm.ai/userapi/v1/user-profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Authorization": `Bearer ${token}`,
        },
        body: "{}",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`autoclaw profile ${res.status} ${text}`);
      }
      profile = await res.json();
    } catch (e) {
      return NextResponse.json({ error: `Invalid access_token: ${e.message}` }, { status: 400 });
    }

    // Best-effort balance — don't block save if wallet unavailable
    let balance = null;
    try {
      const bal = await getAutoclawBalance(token, { deviceId: device });
      balance = bal.balance;
    } catch {
      // non-fatal
    }

    // Extract identity
    const data = profile?.data || profile || {};
    const userId = data.user_id || data.userId || profile?.user_id;
    const userName = data.user_name || data.userName || profile?.user_name;

    // Persist via the shared connection API
    const conn = await createProviderConnection({
      provider: "autoclaw",
      authType: "access_token",
      name: userName || String(userId || "autoclaw-import"),
      email: String(userId || "unknown"),
      accessToken: token,
      refreshToken: String(refreshToken).trim(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      testStatus: "active",
      lastRefreshAt: new Date().toISOString(),
      providerSpecificData: {
        deviceId: device,
        userName,
        balance,
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        importedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: conn.id,
        email: conn.email,
        name: conn.name,
        balance,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
