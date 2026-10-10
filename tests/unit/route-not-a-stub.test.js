// No API route may be a stub that reports success.
//
// Route parity with 9router-go was proven by comparing route TABLES — and that
// check passed while three handlers were still broken (a boolean returned where
// a Response was required, a reorder route ignoring its own `direction` field,
// a reorder route 500ing because a barrel never re-exported its helper). A
// route table cannot see any of that. The failure mode this pins is the
// cheapest one to ship by accident and the hardest to notice:
//
//     export async function GET() {
//       return NextResponse.json({ success: true, items: [] });
//     }
//
// The rule: a handler whose only JSON bodies are object literals AND that
// imports nothing but `next/server` reads no state. It cannot be reporting
// anything real. Deleting the file would be more honest than keeping it.
//
// A health probe legitimately returns constants, so the rule is scoped to
// routes that also declare a state-shaped contract (a `route.js` under
// src/app/api). If such a route ever needs an exemption, it should be listed
// here WITH the reason — silently widening the rule is how the guard dies.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API_ROOT = "src/app/api";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.js") out.push(full);
  }
  return out;
}

// Reads state: any import that is not `next/server`, or a direct syscall.
const READS_STATE = /from "(?!next\/server)[^"]+"|require\(|fetch\(|execSync|spawn\(|readFile/;
// A JSON body whose braces close on the same statement — i.e. all literals.
const LITERAL_BODY = /NextResponse\.json\(\s*\{[^}]*\}\s*\)/s;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("api routes are not constant-body stubs", () => {
  it("every route with a JSON body reads real state", () => {
    const offenders = [];
    for (const file of walk(API_ROOT)) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (!LITERAL_BODY.test(code)) continue;
      if (READS_STATE.test(code)) continue;
      offenders.push(relative(process.cwd(), file));
    }
    expect(offenders, `stub-shaped routes: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the detector fires on a stub (negative control)", () => {
    // Keeps the guard from silently passing because the regexes rotted.
    const stub = `import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({ success: true, items: [] }); }`;
    const code = stripComments(stub);
    expect(LITERAL_BODY.test(code)).toBe(true);
    expect(READS_STATE.test(code)).toBe(false);
  });

  it("the detector clears a handler that reads state", () => {
    const real = `import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
export async function GET() {
  const rows = await getProviderConnections();
  return NextResponse.json({ items: rows });
}`;
    const code = stripComments(real);
    expect(READS_STATE.test(code)).toBe(true);
  });
});
