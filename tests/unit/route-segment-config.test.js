// Guard for route segment config in the App Router API tree.
//
// Next requires segment config (`dynamic`, `runtime`, `revalidate`, `fetchCache`,
// `maxDuration`, ...) to be statically parseable in the file that owns the route.
// A re-exported one is not parseable, and Turbopack aborts the build:
//
//   Next.js can't recognize the exported `dynamic` field in route.
//   It mustn't be reexported.
//
// The webpack build tolerates it, so the defect can sit in the tree indefinitely
// and only surface when someone builds with Turbopack or runs `next dev` — which
// is why this is a whole-tree scan and not an assertion about three files.
//
// The alias routes (one implementation, two URLs) must therefore re-export the
// handler only; if the implementation ever needs a segment config, the alias
// declares its own.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apiDir = resolve(root, "src/app/api");

const SEGMENT_CONFIG = /\b(dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration)\b/;

function routeFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith("route.js"));
}

describe("route segment config", () => {
  it("is never re-exported from another module", () => {
    const offenders = [];
    for (const rel of routeFiles(apiDir)) {
      const src = readFileSync(resolve(apiDir, rel), "utf8");
      for (const decl of src.match(/export \{[^}]*\} from/g) || []) {
        if (SEGMENT_CONFIG.test(decl)) offenders.push(`${rel}: ${decl}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the route tree it is supposed to scan", () => {
    // A guard that silently scans nothing passes forever.
    expect(routeFiles(apiDir).length).toBeGreaterThan(100);
  });

  it("the version aliases exist and re-export the handler", () => {
    for (const p of ["status", "check"]) {
      const src = readFileSync(resolve(apiDir, `version/${p}/route.js`), "utf8");
      expect(src).toMatch(/export \{ GET \} from "\.\.\/route\.js"/);
    }
  });
});
