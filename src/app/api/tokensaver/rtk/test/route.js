import { NextResponse } from "next/server";
import { resolveFilter } from "open-sse/rtk/registry.js";
import { safeApply } from "open-sse/rtk/applyFilter.js";
import { autoDetectFilter } from "open-sse/rtk/autodetect.js";

export const dynamic = "force-dynamic";

// POST /api/tokensaver/rtk/test — run one RTK filter over a sample and report
// what it saved (9router-go parity).
//
// This calls the SAME resolveFilter/safeApply pair the live pipeline uses, so a
// filter that looks good here behaves identically on a real request. Omit
// `filter` to let autodetect choose, which is what actually happens in flight.
export async function POST(request) {
  try {
    const body = await request.json();
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    let fn;
    let chosen = body?.filter || null;
    if (chosen) {
      fn = resolveFilter(chosen);
      if (!fn) return NextResponse.json({ error: `unknown filter: ${chosen}` }, { status: 400 });
    } else {
      fn = autoDetectFilter(text);
      if (!fn) return NextResponse.json({ error: "no filter matched this input" }, { status: 409 });
      chosen = fn.filterName || fn.name;
    }

    const output = safeApply(fn, text);
    const bytesBefore = text.length;
    const bytesAfter = output.length;
    return NextResponse.json({
      filter: chosen,
      autodetected: !body?.filter,
      bytesBefore,
      bytesAfter,
      saved: Math.max(0, bytesBefore - bytesAfter),
      // The pipeline refuses to grow a body: report the decision, not just the text.
      applied: bytesAfter > 0 && bytesAfter < bytesBefore,
      output,
    });
  } catch (error) {
    console.error("POST /api/tokensaver/rtk/test failed:", error);
    return NextResponse.json({ error: "Failed to run filter" }, { status: 500 });
  }
}
