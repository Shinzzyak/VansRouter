import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";

export const dynamic = "force-dynamic";

// Ported from 9router-go's Qoder catalog fix (CHANGELOG v1.9.17-exp.10): a failed
// catalog fetch holds non-forced fetches off for 30s so an unreachable catalog no
// longer makes every request queue behind a fresh fetch and its timeout.
// This route had no cache at all — each dashboard render paid the full 5s
// AbortSignal timeout while the upstream was down, and the client-side fetcher
// only caches successes, so failures retried on every render.
const FAILURE_HOLD_MS = 30 * 1000;
const failureHold = new Map(); // key: url → holdUntil

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  // A forced fetch (chat's last resort) ignores the hold; the dashboard's
  // suggested-models poll does not.
  const forced = searchParams.get("force") === "1";
  const holdUntil = failureHold.get(url);
  if (!forced && holdUntil && Date.now() < holdUntil) {
    return NextResponse.json({ data: [], held: true });
  }

  try {
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      failureHold.set(url, Date.now() + FAILURE_HOLD_MS);
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    // Resolve registry entry by provider name so filters can use the registry as source of truth.
    // Convention: <provider>-free key → strip suffix to find registry id (e.g. "nvidia-free" → "nvidia").
    const providerId = type.endsWith("-free") ? type.slice(0, -"-free".length) : type;
    const data = filter(Array.isArray(raw) ? raw : []);
    // A landed snapshot clears the hold; a failed refresh never empties it.
    failureHold.delete(url);
    return NextResponse.json({ data });
  } catch {
    failureHold.set(url, Date.now() + FAILURE_HOLD_MS);
    return NextResponse.json({ data: [] });
  }
}