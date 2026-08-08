"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import FarmPanel from "./FarmPanel";
import PoolPanel from "./PoolPanel";
import GrokPanel from "./GrokPanel";
import "./harvest.css";

const TABS = [
  { id: "farm", label: "Farm" },
  { id: "pool", label: "Account Pool" },
  { id: "grok", label: "Grok" },
];

export function useHarvestApi() {
  return useCallback(async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `${method} ${url} → ${res.status}`);
    }
    return data;
  }, []);
}

export default function HarvestClient() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "farm";
  const [tab, setTab] = useState(TABS.some((t) => t.id === initialTab) ? initialTab : "farm");
  const [sseState, setSseState] = useState("connecting"); // connecting | live | dead
  const [events, setEvents] = useState([]);
  const maxEventsRef = useRef(200);
  const api = useHarvestApi();

  useEffect(() => {
    let es = null;
    let retry = 0;

    function connect() {
      setSseState("connecting");
      es = new EventSource("/api/harvest/stream");
      es.onopen = () => {
        retry = 0;
        setSseState("live");
      };
      es.onmessage = (e) => {
        // unnamed message → treat as generic log
        pushEvent({ type: "message", data: e.data });
      };
      es.addEventListener("harvest_log", (e) => pushEvent({ type: "harvest_log", data: e.data }));
      es.addEventListener("harvest_result", (e) => pushEvent({ type: "harvest_result", data: e.data }));
      es.addEventListener("harvest_error", (e) => pushEvent({ type: "harvest_error", data: e.data }));
      es.addEventListener("harvest_done", (e) => pushEvent({ type: "harvest_done", data: e.data }));
      es.addEventListener("grok_log", (e) => pushEvent({ type: "grok_log", data: e.data }));
      es.addEventListener("token_saved", (e) => pushEvent({ type: "token_saved", data: e.data }));
      es.addEventListener("bulk_done", (e) => pushEvent({ type: "bulk_done", data: e.data }));
      es.addEventListener("account_saved", (e) => pushEvent({ type: "account_saved", data: e.data }));
      es.onerror = () => {
        setSseState("dead");
        es?.close();
        retry += 1;
        setTimeout(connect, Math.min(3000 * retry, 15000));
      };
    }

    function pushEvent(ev) {
      setEvents((prev) => {
        const next = [...prev, ev];
        return next.length > maxEventsRef.current ? next.slice(next.length - maxEventsRef.current) : next;
      });
    }

    connect();
    return () => es?.close();
  }, []);

  const liveEvents = (prefix) => events.filter((e) => e.type.startsWith(prefix));
  const clearEvents = () => setEvents([]);

  return (
    <div className="harvest-root">
      <div className="harvest-header">
        <h1 className="harvest-title">Harvest Console</h1>
        <div className="harvest-sse">
          <span className={`harvest-dot ${sseState}`} />
          {sseState === "live" ? "SSE live" : sseState === "connecting" ? "connecting…" : "reconnecting…"}
        </div>
      </div>

      <div className="harvest-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`harvest-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="harvest-body">
        {tab === "farm" && <FarmPanel api={api} events={liveEvents("harvest_")} clearEvents={clearEvents} />}
        {tab === "pool" && <PoolPanel api={api} />}
        {tab === "grok" && <GrokPanel api={api} events={liveEvents("grok_")} clearEvents={clearEvents} />}
      </div>
    </div>
  );
}
