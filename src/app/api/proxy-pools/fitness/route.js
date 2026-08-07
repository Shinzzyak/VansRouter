import { NextResponse } from "next/server";
import { poolFitnessSnapshot } from "open-sse/services/proxyPoolFitness.js";

export async function GET() {
  try { return NextResponse.json({ pools: await poolFitnessSnapshot() }); }
  catch (error) { console.log("Error reading proxy fitness:", error); return NextResponse.json({ error: "Failed to read proxy fitness" }, { status: 500 }); }
}
