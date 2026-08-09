import { getProviderConnections } from "@/lib/localDb.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const all = await getProviderConnections({ provider: "grok-cli" });
  const inactive = all.filter((c) => !c.isActive);
  const exhausted = inactive.filter(
    (c) =>
      c.testStatus === "unavailable" &&
      c.lastError &&
      /free[-_]?usage[-_]?exhausted|subscription:free-usage-exhausted/i.test(c.lastError)
  );

  return Response.json({
    total: all.length,
    active: all.filter((c) => c.isActive).length,
    inactive: inactive.length,
    exhaustedCandidates: exhausted.length,
    inactiveDetails: inactive.map((c) => ({
      id: c.id,
      email: c.email,
      testStatus: c.testStatus,
      lastError: c.lastError,
      rateLimitedUntil: c.rateLimitedUntil,
    })),
  });
}
