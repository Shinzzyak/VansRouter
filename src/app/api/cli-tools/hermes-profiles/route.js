import { NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

// GET /api/cli-tools/hermes-profiles
//
// Lists the Hermes Agent profiles on this machine so the CLI-tools pane can
// offer them by name. `default` is Hermes' own name for the profile that lives
// at ~/.hermes/config.yaml; every other profile is a directory under
// ~/.hermes/profiles.
export async function GET(request) {
  const auth = await requireDashboardAuth(request);
  if (auth) return auth;

  try {
    const hermesHome = process.env.HERMES_HOME || path.join(homedir(), ".hermes");
    const profilesDir = path.join(hermesHome, "profiles");
    const profiles = [];

    if (existsSync(path.join(hermesHome, "config.yaml"))) {
      profiles.push({ name: "default", path: hermesHome, hasConfig: true });
    }

    if (existsSync(profilesDir)) {
      for (const entry of readdirSync(profilesDir)) {
        const dir = path.join(profilesDir, entry);
        if (!statSync(dir).isDirectory()) continue;
        profiles.push({
          name: entry,
          path: dir,
          hasConfig: existsSync(path.join(dir, "config.yaml")),
        });
      }
    }

    return NextResponse.json({ installed: profiles.length > 0, hermesHome, profiles });
  } catch (error) {
    console.error("GET /api/cli-tools/hermes-profiles failed:", error);
    return NextResponse.json({ error: "Failed to list Hermes profiles" }, { status: 500 });
  }
}
