import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];

// Severity order for the runtime capture threshold (mirrors the server log
// levels: debug < info < warn < error). "log" is treated as info — console.log
// is how this codebase reports ordinary progress.
export const LOG_LEVELS = ["debug", "info", "warn", "error"];
const LEVEL_RANK = { debug: 0, info: 1, log: 1, warn: 2, error: 3 };
const DEFAULT_LOG_LEVEL = "info";

function normalizeLevel(level) {
  const lower = String(level || "").toLowerCase();
  return LOG_LEVELS.includes(lower) ? lower : null;
}

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}

if (!state.pendingLines) state.pendingLines = [];
if (!state.level) state.level = DEFAULT_LOG_LEVEL;
if (!state.entries) state.entries = [];
if (!state.flushTimer) state.flushTimer = null;

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;

function flushPendingLines() {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;

  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit("lines", lines);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  state.flushTimer?.unref?.();
}

function toLogLine(level, args) {
  return args.map(formatArg).join(" ");
}

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function appendLine(line, level = "log") {
  // Runtime capture threshold: everything below the configured level is
  // dropped at the source, so a debug storm cannot evict the buffer that the
  // dashboard is about to read.
  const rank = LEVEL_RANK[level] ?? LEVEL_RANK.log;
  if (rank < (LEVEL_RANK[state.level] ?? LEVEL_RANK.info)) return;

  const entry = { time: new Date().toISOString(), level: level === "log" ? "info" : level, line };
  state.entries.push(entry);
  state.logs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
    state.entries = state.entries.slice(-maxLines);
  }
  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

export function initConsoleLogCapture() {
  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      appendLine(toLogLine(level, args), level);
      state.originals[level](...args);
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  return state.logs;
}

// Structured view: [{time, level, line}], the same shape 9router-go streams.
export function getConsoleLogEntries() {
  return state.entries;
}

export function getConsoleLogLevel() {
  return state.level;
}

// Returns the applied level, or null when the caller sent an unknown one.
export function setConsoleLogLevel(level) {
  const next = normalizeLevel(level);
  if (!next) return null;
  state.level = next;
  return next;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.entries = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
