import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { clearModelCooldown, clearProviderCooldowns } from "@/lib/providerHealthReset.js";

export const dynamic = "force-dynamic";

// POST /admin/health/reset?provider=&model=
//
// go-parity alias of the dashboard's clearCooldown action. `model` is optional:
// without it every cooldown and unavailable flag for the provider is cleared,
// which is what an operator reaches for after fixing an upstream outage.
export async function POST(request) {
  const auth = await requireDashboardAuth(request);
  if (auth) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get("provider") || "").trim();
    const model = (searchParams.get("model") || "").trim();

    if (!provider) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }

    const result = model ? await clearModelCooldown(provider, model) : await clearProviderCooldowns(provider);
    return NextResponse.json({ status: "ok", provider, model: model || null, ...result });
  } catch (error) {
    console.error("POST /admin/health/reset failed:", error);
    return NextResponse.json({ error: error.message || "Failed to reset provider health" }, { status: 500 });
  }
}
