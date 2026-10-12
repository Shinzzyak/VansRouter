import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getApiKeyUsageSnapshot } from "@/lib/localDb";
import { parseModelAllowlistBody } from "@/lib/db/repos/apiKeyModelAccessRepo.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    const keysWithUsage = keys.map((k) => ({
      ...k,
      // Masked identifier so a UI can render a row without the secret in hand.
      keyDisplay: k.keyDisplay,
      usage: getApiKeyUsageSnapshot(k),
    }));
    return NextResponse.json({ keys: keysWithUsage });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
//
// Accepts the same policy surface as PUT: limits, the three ACL lists and the
// per-model allow-list. They may be passed top-level or nested under `limits`.
// Before this, only `limits` was read and the ACL columns were hardcoded NULL
// in the repo, so a key minted with an allow-list came back unrestricted and
// the policy had to be applied with a second PUT.
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, limits = {} } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const pick = (field) => (field in body ? body[field] : limits[field]);

    // The per-model allowlist has its own writer (/api/keys/[id]/models), so it
    // is validated with that route's own parser before it is handed to the
    // repo — a bad shape is a 400 here rather than a half-minted key.
    let allowedModels;
    if (pick("allowedModels") !== undefined) {
      const parsed = parseModelAllowlistBody(pick("allowedModels"));
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      allowedModels = parsed.models;
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, {
      ...limits,
      allowedProviders: pick("allowedProviders"),
      allowedCombos: pick("allowedCombos"),
      allowedKinds: pick("allowedKinds"),
      allowedModels,
      personaInject: pick("personaInject"),
    });

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      keyDisplay: apiKey.keyDisplay,
      limits: {
        expiresAt: apiKey.expiresAt,
        maxTokens: apiKey.maxTokens,
        maxTokensDaily: apiKey.maxTokensDaily,
        rpm: apiKey.rpm,
        rph: apiKey.rph,
        rpd: apiKey.rpd,
        tokens5h: apiKey.tokens5h,
        tokensWeekly: apiKey.tokensWeekly,
        tokensMonthly: apiKey.tokensMonthly,
        rateLimitTpm: apiKey.rateLimitTpm,
        rateLimitConcurrency: apiKey.rateLimitConcurrency,
      },
      allowedProviders: apiKey.allowedProviders,
      allowedCombos: apiKey.allowedCombos,
      allowedKinds: apiKey.allowedKinds,
      allowedModels: apiKey.allowedModels,
      personaInject: apiKey.personaInject,
      metadata: apiKey.metadata,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
