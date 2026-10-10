import { NextResponse } from "next/server";
import { injectCaveman } from "open-sse/rtk/caveman.js";
import { CAVEMAN_PROMPTS } from "open-sse/rtk/cavemanPrompts.js";
import { FORMATS } from "open-sse/translator/formats.js";

export const dynamic = "force-dynamic";

// POST /api/tokensaver/caveman/test — preview the caveman injection (9router-go
// parity). Builds a throwaway body in the requested format, runs the REAL
// injectCaveman over it, and returns both the prompt for the level and where the
// injection landed. Read-only: nothing is dispatched.
export async function POST(request) {
  try {
    const body = await request.json();
    const level = body?.level || "full";
    const prompt = CAVEMAN_PROMPTS[level];
    if (!prompt) {
      return NextResponse.json(
        { error: `unknown level: ${level}`, levels: Object.keys(CAVEMAN_PROMPTS) },
        { status: 400 },
      );
    }

    const format = body?.format || FORMATS.OPENAI;
    const sample = {
      model: body?.model || "test-model",
      messages: [
        { role: "system", content: body?.system || "You are a helpful assistant." },
        { role: "user", content: body?.user || "Summarize the repo." },
      ],
    };
    injectCaveman(sample, format, level);

    return NextResponse.json({
      level,
      format,
      levels: Object.keys(CAVEMAN_PROMPTS),
      prompt,
      injectedBody: sample,
    });
  } catch (error) {
    console.error("POST /api/tokensaver/caveman/test failed:", error);
    return NextResponse.json({ error: "Failed to preview caveman injection" }, { status: 500 });
  }
}
