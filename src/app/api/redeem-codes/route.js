import { NextResponse } from "next/server";
import { createRedeemCodes, getRedeemCodes } from "@/lib/db/repos/redeemCodesRepo.js";
import { sanitizeQuotaLimits } from "@/shared/utils/keyQuota";

export const dynamic = "force-dynamic";

// Admin surface for redeem codes — the product itself.
// A seller mints a batch, hands the codes out, and the buyer spends one on the
// public redeem page (POST /api/v1/redeem), which issues the key it buys.
//
// Admin-only by placement (dashboardGuard covers /api/*): a buyer can spend a
// code but can neither list nor mint them.

// GET /api/redeem-codes?batchName=&includeRevoked=0
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const batchName = url.searchParams.get("batchName");
    const includeRevoked = url.searchParams.get("includeRevoked") !== "0";

    const codes = await getRedeemCodes({ batchName, includeRevoked });
    return NextResponse.json({
      codes,
      count: codes.length,
      summary: {
        total: codes.length,
        revoked: codes.filter((c) => !c.isActive).length,
        exhausted: codes.filter((c) => c.usedCount >= c.maxUses).length,
        unused: codes.filter((c) => c.usedCount === 0 && c.isActive).length,
      },
    });
  } catch (error) {
    console.log("Error listing redeem codes:", error);
    return NextResponse.json({ error: "Failed to list redeem codes" }, { status: 500 });
  }
}

// POST /api/redeem-codes
// { quantity, batchName?, tokenValue?, extendsDays?, maxUses?, expiresAt?, metadata?, limits? }
//
// `tokenValue` + `extendsDays` are the short form (quota + validity). `limits`
// is the whole key policy the code hands the buyer: rpm, rateLimitTpm,
// rateLimitConcurrency, maxTokens, maxTokensDaily, tokens5h, tokensWeekly,
// tokensMonthly, tokenBalance, allowedIps, personaInject. A code has to carry
// at least one axis from either form, otherwise it would buy nothing.
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      quantity = 1,
      batchName = null,
      tokenValue = null,
      extendsDays = null,
      maxUses = 1,
      expiresAt = null,
      metadata = null,
      limits = null,
    } = body || {};

    const policy = sanitizeQuotaLimits(limits);
    if (!policy.ok) {
      return NextResponse.json({ error: policy.error }, { status: 400 });
    }

    const tokens = tokenValue === null || tokenValue === undefined || tokenValue === "" ? null : Number(tokenValue);
    const days = extendsDays === null || extendsDays === undefined || extendsDays === "" ? null : Number(extendsDays);
    if (tokens === null && days === null && policy.set === 0) {
      return NextResponse.json(
        { error: "tokenValue, extendsDays or limits is required" },
        { status: 400 }
      );
    }
    if (tokens !== null && (!Number.isFinite(tokens) || tokens < 0)) {
      return NextResponse.json({ error: "tokenValue must be a non-negative number" }, { status: 400 });
    }
    if (days !== null && (!Number.isFinite(days) || days < 0)) {
      return NextResponse.json({ error: "extendsDays must be a non-negative number" }, { status: 400 });
    }

    const codes = await createRedeemCodes({
      quantity,
      batchName,
      tokenValue: tokens,
      extendsDays: days,
      maxUses,
      expiresAt,
      metadata,
      limits: policy.set > 0 ? policy.limits : null,
    });

    return NextResponse.json({ count: codes.length, codes }, { status: 201 });
  } catch (error) {
    console.log("Error creating redeem codes:", error);
    return NextResponse.json({ error: error?.message || "Failed to create redeem codes" }, { status: 500 });
  }
}
