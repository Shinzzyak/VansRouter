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

    // Batch mint: a seller filling orders should not have to fire one request
    // per key. Capped at 100 per call; a batch gets "name #n" suffixes so the
    // rows stay tellable apart in the dashboard.
    const rawQuantity = Number(body.quantity);
    const quantity = Number.isFinite(rawQuantity) ? Math.min(100, Math.max(1, Math.floor(rawQuantity))) : 1;

    // An IP allow-list is security-relevant, so a malformed one is a 400 rather
    // than a silent fallback to "any source" (which is what normalizePerm would
    // do with a non-array).
    const allowedIps = pick("allowedIps");
    if (allowedIps !== undefined && allowedIps !== null) {
      if (!Array.isArray(allowedIps) || allowedIps.some((ip) => typeof ip !== "string" || !ip.trim())) {
        return NextResponse.json({ error: "allowedIps must be an array of non-empty strings" }, { status: 400 });
      }
    }

    const policy = {
      ...limits,
      allowedProviders: pick("allowedProviders"),
      allowedCombos: pick("allowedCombos"),
      allowedKinds: pick("allowedKinds"),
      allowedModels,
      allowedIps: allowedIps === undefined ? null : allowedIps,
      tokenBalance: pick("tokenBalance"),
      personaInject: pick("personaInject"),
    };

    const created = [];
    for (let i = 0; i < quantity; i += 1) {
      const label = quantity > 1 ? `${name} #${i + 1}` : name;
      created.push(await createApiKey(label, machineId, policy));
    }

    const shape = (apiKey) => ({
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
        tokenBalance: apiKey.tokenBalance,
      },
      allowedProviders: apiKey.allowedProviders,
      allowedCombos: apiKey.allowedCombos,
      allowedKinds: apiKey.allowedKinds,
      allowedModels: apiKey.allowedModels,
      allowedIps: apiKey.allowedIps,
      personaInject: apiKey.personaInject,
      metadata: apiKey.metadata,
    });

    // Single-key response keeps the shape every existing caller expects; a batch
    // adds the array instead of pretending to be one key.
    if (created.length === 1) {
      return NextResponse.json(shape(created[0]), { status: 201 });
    }
    return NextResponse.json(
      { count: created.length, keys: created.map(shape) },
      { status: 201 }
    );
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
