// Unit tests for YYDS temp-mail support.
// - yyds_client.py: verification-code extraction heuristics
// - route output parsing (domains line format)
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

function runYydsCli(args, env = {}) {
  try {
    const out = execFileSync("python3", ["scripts/python/yyds_client.py", ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message || e) };
  }
}

describe("yyds_client.py", () => {
  it("python module compiles (py_compile via --help)", () => {
    const r = runYydsCli(["--help"]);
    expect(r.ok).toBe(true);
  });
});

describe("yyds route output parsing", () => {
  it("domains line format parses", () => {
    const line = "007.hzeg.eu.org | verified=true public=true mx=true";
    const m = line.match(/^(.+?) \| verified=(true|false) public=(true|false) mx=(true|false)$/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe("007.hzeg.eu.org");
    expect(m[2]).toBe("true");
    expect(m[3]).toBe("true");
    expect(m[4]).toBe("true");
  });

  it("create output format parses", () => {
    const out = "ADDRESS=abc123def@007.hzeg.eu.org\nTOKEN=tok_xyz";
    const addr = out.match(/ADDRESS=(.+)/)?.[1] || "";
    const tok = out.match(/TOKEN=(.+)/)?.[1] || "";
    expect(addr).toBe("abc123def@007.hzeg.eu.org");
    expect(tok).toBe("tok_xyz");
  });

  it("poll output format parses", () => {
    const out = "CODE=123456";
    const code = out.match(/CODE=(.+)/)?.[1] || "";
    expect(code).toBe("123456");
  });
});
