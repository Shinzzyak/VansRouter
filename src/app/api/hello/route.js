import pkg from "../../../../package.json" with { type: "json" };
import { UPDATER_CONFIG } from "@/shared/constants/config";

export const dynamic = "force-dynamic";

// GET /api/hello — liveness/identity probe (9router-go parity). Unauthenticated
// on purpose: it is the endpoint a load balancer or a buyer's monitoring script
// hits to answer "is this router up, and which build is it". It exposes the
// version and channel, never a credential or a connection detail.
export async function GET() {
  return Response.json({
    ok: true,
    name: "vansrouter",
    version: pkg.version,
    channel: UPDATER_CONFIG.updateChannel,
    buildId: process.env.RELEASE_BUILD_ID || null,
    uptimeSeconds: Math.floor(process.uptime()),
    time: new Date().toISOString(),
  });
}
