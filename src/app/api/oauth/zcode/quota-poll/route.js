import { execFile } from "node:child_process";
import { NextResponse } from "next/server";
import path from "node:path";

// POST /api/oauth/zcode/quota-poll — jalankan zai_quota_poll.py + return hasil
export async function POST() {
  const script = path.join(
    process.cwd(),
    "scripts/python/zcodereg/zai_quota_poll.py",
  );
  const py = process.env.ZAI_POLL_PYTHON || "python3";

  return new Promise((resolve) => {
    execFile(py, [script, "--sleep", "1", "--limit", "108"], { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(
          NextResponse.json(
            { ok: false, error: String(err.message || err).slice(0, 300), stderr: String(stderr).slice(-500) },
            { status: 500 },
          ),
        );
        return;
      }
      // parse output baris [i/N] name: code=X reset_at=Y
      const lines = String(stdout).split("\n").filter((l) => /^\s*\[\d+\/\d+\]/.test(l));
      const parsed = lines.map((l) => {
        const m = l.match(/\[(\d+)\/(\d+)\]\s+(\S+):\s+code=(\S+)\s+reset_at=(\S+)/);
        return m
          ? { index: Number(m[1]), total: Number(m[2]), name: m[3], code: m[4], resetAt: m[5] }
          : { raw: l.trim() };
      });
      const ok = parsed.filter((p) => p.code === "0").length;
      resolve(NextResponse.json({ ok: true, total: parsed.length, okCount: ok, results: parsed }));
    });
  });
}