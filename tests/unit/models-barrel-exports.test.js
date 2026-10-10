// Structural guard: every named import a route takes from the `@/models`
// barrel must actually be re-exported by it.
//
// Why: `reorderProviderConnections` lived in `lib/db/repos/connectionsRepo.js`
// and was re-exported by `lib/localDb.js`, but the `@/models` barrel never
// listed it. Two routes imported it from the barrel, so the binding resolved to
// `undefined` and the handler threw `TypeError: reorderProviderConnections is
// not a function` -> HTTP 500 on a live call. Nothing in the unit suite caught
// it because no test imported those routes.
//
// This is a cheap whole-tree check: parse the barrel's re-export lists, then
// walk every route file and diff. It reads source text on purpose — importing
// the barrel would drag in the DB driver.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");

function collectFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(p, acc);
    else if (entry.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function barrelExports() {
  const text = fs.readFileSync(path.join(SRC, "models/index.js"), "utf8");
  const names = new Set();
  for (const block of text.matchAll(/export\s*\{([\s\S]*?)\}\s*from\s*"[^"]+"/g)) {
    for (const raw of block[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  return names;
}

describe("@/models barrel", () => {
  it("re-exports every name the API routes import from it", () => {
    const exported = barrelExports();
    expect(exported.size).toBeGreaterThan(20);

    const offenders = [];
    for (const file of collectFiles(path.join(SRC, "app/api"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/models"/g)) {
        for (const raw of m[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim();
          if (name && !exported.has(name)) {
            offenders.push(`${path.relative(SRC, file)} -> ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually lists the two reorder/cleanup helpers the routes call", () => {
    const exported = barrelExports();
    expect(exported.has("reorderProviderConnections")).toBe(true);
    expect(exported.has("cleanupProviderConnections")).toBe(true);
  });
});
