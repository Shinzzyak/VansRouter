// Proxy scraper service — fetches free proxy lists from public sources
// and imports them into proxyPools. Sources: Geonode API + configurable list.
// Kept dependency-free: plain fetch, no axios.

const PROXY_SOURCES = [
  {
    id: "geonode",
    label: "Geonode",
    // sorted by responseTime asc, limit 500
    url: "https://proxylist.geonode.com/api/proxy-list?page=1&limit=500&sort_by=responseTime&sort_type=asc",
    parse: (json) =>
      (json?.data || []).map((p) => ({
        proxyUrl: `${(p.protocols?.[0] || p.protocol || "http")}://${p.ip}:${p.port}`,
        type: (p.protocols?.[0] || p.protocol || "http") === "https" ? "https" : "http",
        country: p.country || "",
        responseTime: p.responseTime ?? p.latency ?? null,
        anonymity: p.anonymityLevel || "",
        source: "geonode",
      })),
  },
  {
    id: "proxyscrape",
    label: "ProxyScrape",
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=json&timeout=5000",
    parse: (json) =>
      (json?.proxies || []).map((p) => ({
        proxyUrl: `http://${p.proxy}`,
        type: "http",
        country: p.country || "",
        responseTime: p.speed ? Math.round(1000 / p.speed) : null,
        anonymity: "",
        source: "proxyscrape",
      })),
  },
  {
    id: "free-proxy-list",
    label: "FreeProxyList (GitHub)",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    parse: (text) =>
      String(text)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ proxyUrl: `http://${line.trim()}`, type: "http", source: "free-proxy-list" })),
  },
];

const DEDUPE_KEY = (p) => p.proxyUrl.replace(/^https?:\/\//, "");

export async function scrapeProxies({ sources = [], limit = 500 } = {}) {
  const active = PROXY_SOURCES.filter((s) => sources.length === 0 || sources.includes(s.id));
  const results = [];
  const seen = new Set();

  for (const src of active) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(src.url, { signal: ctrl.signal, headers: { "User-Agent": "VansRouter/0.9.99" } });
      clearTimeout(timer);
      if (!res.ok) {
        results.push({ source: src.id, ok: false, error: `HTTP ${res.status}`, count: 0 });
        continue;
      }
      const isJson = res.headers.get("content-type")?.includes("application/json");
      const raw = isJson ? await res.json() : await res.text();
      let items = src.parse(raw) || [];
      items = items.filter((p) => p.proxyUrl && /^https?:\/\/[\w.:-]+:\d+$/.test(p.proxyUrl));
      let added = 0;
      for (const item of items) {
        const key = DEDUPE_KEY(item);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ source: src.id, ok: true, count: ++added, ...item });
        if (results.filter((r) => r.ok).length >= limit) break;
      }
      if (added === 0) results.push({ source: src.id, ok: true, count: 0, error: "no valid entries" });
    } catch (e) {
      results.push({ source: src.id, ok: false, error: e.message, count: 0 });
    }
  }
  return results.filter((r) => r.ok);
}
