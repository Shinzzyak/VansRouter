import { NextResponse } from "next/server";
import { scrapeProxies } from "@/lib/proxyScraper";
import { createProxyPool } from "@/lib/db/repos/proxyPoolsRepo";

// GET /api/proxy-scraper?source=geonode&limit=100 — list matching pools
// POST /api/proxy-scraper — scrape + import into proxyPools
//   body: { sources: ["geonode"], limit: 200, import: true, namePrefix: "scraped" }

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const source = searchParams.get("source") || "";
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 500);
    const results = await scrapeProxies({ sources: source ? [source] : [], limit });
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const limit = Math.min(parseInt(body.limit || "200", 10) || 200, 1000);
    const namePrefix = body.namePrefix || "scraped";

    const results = await scrapeProxies({ sources, limit });
    let imported = 0;
    const seen = new Set();

    if (body.import !== false) {
      for (const r of results) {
        const key = r.proxyUrl.replace(/^https?:\/\//, "");
        if (seen.has(key)) continue;
        seen.add(key);
        await createProxyPool({
          name: `${namePrefix}-${r.source}-${r.country || "any"}`.slice(0, 60),
          proxyUrl: r.proxyUrl,
          type: r.type || "http",
          isActive: true,
          testStatus: "unknown",
        });
        imported++;
      }
    }
    return NextResponse.json({ ok: true, scraped: results.length, imported, results: results.slice(0, 20) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
