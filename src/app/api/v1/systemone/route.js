import { handleSystemone } from "@/sse/handlers/systemone.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/systemone - calibrated decision engine (v1m / Jev) pass-through */
export async function POST(request) {
  return await handleSystemone(request);
}
