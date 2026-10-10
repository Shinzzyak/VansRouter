import { NextResponse } from "next/server";
import { getConsoleLogLevel, initConsoleLogCapture, setConsoleLogLevel } from "@/lib/consoleLogBuffer";

export const dynamic = "force-dynamic";

initConsoleLogCapture();

// GET /api/translator/console-logs/level
export async function GET() {
  return NextResponse.json({ success: true, level: getConsoleLogLevel() });
}

// PUT /api/translator/console-logs/level  { level: "debug"|"info"|"warn"|"error" }
//
// Runtime change, no restart: the capture threshold is read per log call.
export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
  }

  const level = setConsoleLogLevel(body?.level);
  if (!level) {
    return NextResponse.json({ error: "invalid log level (debug, info, warn, error)" }, { status: 400 });
  }
  return NextResponse.json({ success: true, level });
}
