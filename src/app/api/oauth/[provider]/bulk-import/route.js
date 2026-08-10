import { NextResponse } from "next/server";
import {
  getBulkImportProviderSpec,
  resolveProxyForProvider,
} from "@/lib/oauth/services/bulkImportRegistry";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { provider } = await params;

  let spec;
  try {
    spec = getBulkImportProviderSpec(provider);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  try {
    const body = await request.json();

    const resolvedProxy = await resolveProxyForProvider(spec, body);
    if (resolvedProxy.error) {
      return NextResponse.json({ error: resolvedProxy.error }, { status: 400 });
    }

    const jobArgs = await spec.normalizeStartArgs(body, resolvedProxy);

    // cloudflare-ai signupMode + grok-cli registerCount + ALL signup providers
    // create placeholder accounts in the manager — skip client account parse.
    const skipAccountParse =
      provider === "cloudflare-ai" ||
      provider.endsWith("-signup") ||
      (provider === "grok-cli" && Number(body?.registerCount) > 0);

    if (spec.parseAccounts && !skipAccountParse) {
      const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
      const parsedResult = await spec.parseAccounts(accounts);
      // Signup providers return a plain array (placeholders are created in the
      // manager); account-bearing providers return { parsed, invalidLines }.
      const parsed = Array.isArray(parsedResult) ? parsedResult : parsedResult?.parsed || [];
      const invalidLines = Array.isArray(parsedResult) ? [] : parsedResult?.invalidLines || [];

      const formatHint =
        provider === "grok-cli"
          ? "email|password|sso or access_token|refresh_token"
          : "email@gmail.com|password";

      if (!parsed.length) {
        const payload = {
          error: invalidLines.length > 0
            ? `Invalid account format. Use one account per line: ${formatHint}`
            : "At least one account entry is required",
        };
        if (invalidLines.length > 0) payload.invalidLines = invalidLines;
        return NextResponse.json(payload, { status: 400 });
      }

      if (invalidLines.length > 0) {
        return NextResponse.json(
          {
            error: `Invalid account format. Use one account per line: ${formatHint}`,
            invalidLines,
          },
          { status: 400 }
        );
      }

      jobArgs.accounts = body?.accounts ?? [];
    }

    const manager = await spec.getManager();
    const job = await manager.startJob(jobArgs);

    return NextResponse.json({ success: true, job });
  } catch (error) {
    const status = Array.isArray(error?.invalidLines) ? 400 : 500;
    const payload = {
      error: error?.error || error?.message || `Failed to start ${spec.label} bulk import`,
    };
    if (Array.isArray(error?.invalidLines) && error.invalidLines.length > 0) {
      payload.invalidLines = error.invalidLines;
    }
    return NextResponse.json(payload, { status });
  }
}
