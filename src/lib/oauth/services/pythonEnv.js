import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the Python binary for automation subprocesses.
 *
 * Priority:
 *   1. qoderreg-venv (scripts/python/qoderreg-venv/bin/python3) — has all
 *      automation deps (camoufox, playwright, patchright, rich, requests).
 *   2. System python3 / python.
 *
 * The venv lives under the repo in dev and under .next/standalone/scripts in
 * production (workflow copies scripts/). process.cwd() differs between the
 * two (PM2 runs from the repo root; the bundled server.js runs from
 * standalone), so probe both.
 */
export function findPythonBinary() {
  const candidates = [
    path.join(process.cwd(), "scripts", "python", "qoderreg-venv", "bin", "python3"),
    path.join(process.cwd(), ".next", "standalone", "scripts", "python", "qoderreg-venv", "bin", "python3"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        execFileSync(candidate, ["--version"], { stdio: "ignore" });
        return candidate;
      }
    } catch {
      /* try next */
    }
  }
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return "python3"; // default, will fail with clear ENOENT
}
