import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "../dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
function dirWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        // Read-only FS during `next build` page-data collection — DB adapter
        // falls back to in-memory / tmp; production has a writable DATA_DIR.
        console.warn(`[DB] cannot create ${dir}: ${e.message} — using in-memory fallback`);
        return false;
      }
    } else if (!dirWritable(dir)) {
      // e.g. /home/ubuntu/VansRouter/data exists but is read-only on CI
      console.warn(`[DB] ${dir} not writable — using in-memory fallback`);
      return false;
    }
  }
  return true;
}
