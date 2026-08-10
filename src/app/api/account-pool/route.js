import { NextResponse } from "next/server";
import {
  getProviderConnections,
  getProviderNodes,
  updateProviderConnection,
  deleteProviderConnection,
  createProviderConnection,
} from "@/lib/localDb";
import { getAutoclawBalance } from "open-sse/services/usage/autoclaw.js";

export const dynamic = "force-dynamic";

// GET /api/account-pool?provider=autoclaw — list accounts per provider
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || null;

    const filter = provider ? { provider } : {};
    const connections = await getProviderConnections(filter);

    // Node name map for OpenAI/Anthropic-compatible providers (ugly ids → readable names)
    let nodeNameMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch {}

    // Enrich autoclaw with balance (like existing connections route)
    const enriched = await Promise.all(
      connections.map(async (c) => {
        const row = { ...c };
        row.accessToken = undefined;
        row.refreshToken = undefined;
        row.idToken = undefined;
        row.apiKey = undefined;

        // Resolve display provider name for compatible nodes
        if (c.provider.startsWith("openai-compatible-chat-") || c.provider.startsWith("anthropic-compatible-")) {
          row.displayProvider = nodeNameMap[c.provider] || c.provider;
        } else {
          row.displayProvider = c.provider;
        }

        if (c.provider === "autoclaw" && c.accessToken) {
          try {
            const bal = await getAutoclawBalance(c.accessToken, c.providerSpecificData);
            row.balance = bal.balance;
          } catch (e) {
            row.balanceError = e.message;
          }
        }

        // Group by provider for stats
        return row;
      })
    );

    // Aggregate stats
    const grouped = {};
    for (const c of enriched) {
      if (!grouped[c.provider]) {
        grouped[c.provider] = { total: 0, active: 0, inactive: 0 };
      }
      grouped[c.provider].total += 1;
      if (c.isActive) grouped[c.provider].active += 1;
      else grouped[c.provider].inactive += 1;
    }

    return NextResponse.json({ connections: enriched, grouped });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/account-pool — import accounts manually (token per line or email:password)
export async function POST(request) {
  try {
    const body = await request.json();
    const { provider, lines } = body;

    if (!provider || !Array.isArray(lines) || !lines.length) {
      return NextResponse.json({ error: "provider and lines required" }, { status: 400 });
    }

    const created = [];
    const errors = [];

    for (const line of lines) {
      try {
        const trimmed = String(line).trim();
        if (!trimmed) continue;

        // Format: token (autoclaw-style) or email|token or email:password
        let email = null;
        let token = null;
        if (trimmed.includes("|")) {
          const [e, t] = trimmed.split("|");
          email = e.trim();
          token = t.trim();
        } else if (trimmed.includes(":")) {
          const [e, t] = trimmed.split(":");
          email = e.trim();
          token = t.trim();
        } else {
          token = trimmed;
        }

        const conn = await createProviderConnection({
          provider,
          authType: "access_token",
          name: email || `manual-${Date.now()}`,
          email: email,
          accessToken: token,
          refreshToken: token,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          testStatus: "untested",
          providerSpecificData: {
            importedAt: new Date().toISOString(),
            importSource: "manual-pool",
          },
        });
        created.push(conn);
      } catch (e) {
        errors.push({ line: String(line).slice(0, 40), error: e.message });
      }
    }

    return NextResponse.json({ created: created.length, errors });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH /api/account-pool — toggle active
export async function PATCH(request) {
  try {
    const body = await request.json();
    const { id, isActive } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await updateProviderConnection(id, { isActive: !!isActive });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE /api/account-pool/:id — delete account
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await deleteProviderConnection(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
