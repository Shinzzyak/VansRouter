import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

export const dynamic = "force-dynamic";

// Storage dirs semua automation signup/bulk-import (dari *BulkImportManager storageName)
const STORAGE_DIRS = [
  "tokenharbor-signup-bulk-import",
  "autoclaw-signup-bulk-import",
  "autoclaw-bulk-import",
  "baseten-signup-bulk-import",
  "chatgpt-signup-bulk-import",
  "outlook-signup-bulk-import",
  "qoder-signup-bulk-import",
  "qoder-bulk-import",
  "kiro-bulk-import",
  "grok-bulk-import",
];

const LABELS = {
  "tokenharbor-signup-bulk-import": "Token Harbor",
  "autoclaw-signup-bulk-import": "AutoClaw",
  "autoclaw-bulk-import": "AutoClaw",
  "baseten-signup-bulk-import": "Baseten",
  "chatgpt-signup-bulk-import": "ChatGPT",
  "outlook-signup-bulk-import": "Outlook",
  "qoder-signup-bulk-import": "Qoder",
  "qoder-bulk-import": "Qoder",
  "kiro-bulk-import": "Kiro",
  "grok-bulk-import": "Grok",
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function summarizeJob(job, label) {
  if (!job) return null;
  const accounts = Array.isArray(job.accounts) ? job.accounts : [];
  const countBy = {};
  for (const a of accounts) {
    const st = a.status || "unknown";
    countBy[st] = (countBy[st] || 0) + 1;
  }
  return {
    jobId: job.jobId,
    provider: label,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    counts: countBy,
    total: accounts.length,
    error: job.error || null,
  };
}

// GET /api/automation-history?limit=20 — ringkasan job terbaru semua automation
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(100, Number(searchParams.get("limit")) || 20);

    const jobs = [];
    for (const dirName of STORAGE_DIRS) {
      const dir = path.join(DATA_DIR, dirName);
      if (!fs.existsSync(dir)) continue;
      const meta = readJson(path.join(dir, "meta.json"));
      const latestId = meta?.latestJobId;
      if (!latestId) continue;
      const job = readJson(path.join(dir, `${latestId}.json`));
      const summary = summarizeJob(job, LABELS[dirName] || dirName);
      if (summary) jobs.push(summary);
    }

    // sort by createdAt desc
    jobs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return NextResponse.json({ success: true, jobs: jobs.slice(0, limit) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
