// Guard: a route handler must never hand a boolean back to Next.
//
// `requireDashboardAuth` returns a boolean, so `const auth = await require...;
// if (auth) return auth;` looks like an auth guard but actually returns `true`
// from the handler. Next then throws "No response is returned from route
// handler ... received 'boolean'" and the endpoint 500s — while lint, types and
// every unit test stay green, because the bug only exists at the framework
// boundary. It shipped that way in eight routes and was caught only by the
// deployed e2e probe.
//
// Static check, deliberately: the failure is a source shape, and a runtime test
// would need to boot every route with a valid dashboard session.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(process.cwd(), "src/app/api");

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.js") out.push(full);
  }
  return out;
}

describe("dashboard auth guards", () => {
  const files = routeFiles(API_ROOT);

  it("finds route files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never returns the auth result itself", () => {
    const offenders = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/return\s+auth\s*;/.test(src) || /if\s*\(auth\)\s*return\s+auth/.test(src)) {
        offenders.push(file.replace(process.cwd() + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("guards with a NextResponse on the unauthorized branch", () => {
    const offenders = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("requireDashboardAuth")) continue;
      const ok = /if\s*\(!\s*\(?\s*await\s+requireDashboardAuth/.test(src)
        || /if\s*\(\s*!\s*auth\s*\)\s*\{[^}]*status:\s*401/.test(src)
        || /NextResponse\.json\([^)]*\{[^}]*status:\s*401/.test(src)
        || /unauthorized\s*\(/.test(src);
      if (!ok) offenders.push(file.replace(process.cwd() + "/", ""));
    }
    expect(offenders).toEqual([]);
  });
});
