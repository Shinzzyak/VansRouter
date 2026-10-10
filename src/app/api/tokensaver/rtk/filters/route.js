import { NextResponse } from "next/server";
import { allFilters } from "open-sse/rtk/registry.js";

export const dynamic = "force-dynamic";

// GET /api/tokensaver/rtk/filters — the RTK filter catalog this build can run
// (9router-go parity). Names come from the live registry, so a filter that is
// not wired into the pipeline can never appear here.
export async function GET() {
  const registry = allFilters();
  const filters = Object.keys(registry).map((name) => ({
    name,
    // Pipe aliases the CLI accepts for the same implementation (grep|rg, find|fd).
    aliases: name === "grep" ? ["rg"] : name === "find" ? ["fd"] : [],
  }));
  return NextResponse.json({ filters, count: filters.length });
}
