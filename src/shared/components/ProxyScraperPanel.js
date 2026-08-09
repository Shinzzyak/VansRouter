"use client";

import { useState } from "react";
import Badge from "./Badge";
import Button from "./Button";
import Card from "./Card";
import { useNotificationStore } from "@/store/notificationStore";

const DEFAULT_PROXY_STORAGE_KEY = "auto:defaultProxy";

export default function ProxyScraperPanel() {
  const notify = useNotificationStore();
  const [results, setResults] = useState([]);
  const [scraping, setScraping] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [summary, setSummary] = useState(null);

  const handleScrape = async () => {
    setScraping(true);
    try {
      const res = await fetch("/api/proxy-scraper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 300, namePrefix: "free" }),
      });
      const data = await res.json();
      if (data.ok) {
        setResults(data.results || []);
        setSummary({ scraped: data.scraped, imported: data.imported });
        notify.success(`Scraped ${data.scraped} proxies, imported ${data.imported}`);
      } else {
        notify.error(`Scrape failed: ${data.error || "unknown"}`);
      }
    } catch (e) {
      notify.error(`Scrape error: ${e.message}`);
    } finally {
      setScraping(false);
    }
  };

  const handleCopy = async (proxyUrl, index) => {
    try {
      await navigator.clipboard.writeText(proxyUrl);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const handleSetDefault = (proxyUrl, source) => {
    try {
      window.localStorage.setItem(
        DEFAULT_PROXY_STORAGE_KEY,
        JSON.stringify({ proxyUrl, source: source || "proxy-scraper" })
      );
      notify.success("Default proxy set");
    } catch {
      notify.error("Failed to save default proxy");
    }
  };

  return (
    <Card
      title="Proxy Scraper"
      subtitle="Fetch fresh free proxies from public sources (Geonode, ProxyScrape, FreeProxyList GitHub) and import them as proxy pools."
      icon="public"
      action={
        <Button onClick={handleScrape} disabled={scraping} loading={scraping} size="sm">
          {scraping ? "Scraping…" : "Scrape Free Proxies"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {summary && (
          <p className="text-xs text-text-muted">
            scraped {summary.scraped}, imported {summary.imported}
          </p>
        )}
        {results.length > 0 && (
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
            {results.map((proxy, index) => (
              <div
                key={`${proxy.proxyUrl}-${index}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-white/5 border border-white/10 p-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block max-w-full truncate font-mono text-xs text-text-main" title={proxy.proxyUrl}>
                    {proxy.proxyUrl}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <Badge variant="primary" size="sm">{proxy.type || "http"}</Badge>
                    {proxy.country && <Badge variant="default" size="sm">{proxy.country}</Badge>}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => handleCopy(proxy.proxyUrl, index)}>
                    {copiedIndex === index ? "Copied" : "Copy"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleSetDefault(proxy.proxyUrl, proxy.source)}>
                    Set as default
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
