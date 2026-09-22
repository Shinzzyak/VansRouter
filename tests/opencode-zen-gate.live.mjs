// Live A/B against OpenCode Zen: proves the CURRENT router path 403s and the
// patched header/body set 200s. Not part of the vitest suite (no .test. suffix).
//
//   node tests/opencode-zen-gate.live.mjs
//
// Run before and after the executor change. Exits non-zero if either side
// disagrees with the documented behaviour.
import https from "node:https";

const PATH = "/zen/v1/chat/completions";
const MODELS = ["mimo-v2.5-free", "mimo-v2.6-flash-free"];

// Exact output of open-sse/executors/opencode.js buildHeaders() before the fix.
const CURRENT_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer public",
  "User-Agent": "opencode-cli/1.0.0",
  "x-opencode-client": "opencode-cli",
  "x-opencode-project": "vans-router",
  "x-opencode-session": "ses_" + "a1b2c3d4".repeat(4),
  "x-opencode-request": "msg_" + "b".repeat(26),
  Accept: "*/*",
};

// What the patched executor produces.
const PATCHED_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer public",
  "User-Agent": "opencode/1.18.32",
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": "ses_f388ce237ffeOrv1cC5CyD9Xcq",
  "x-opencode-request": "msg_" + "b".repeat(26),
  Accept: "text/event-stream",
};

// The two tools the free-tier gate requires by name.
const GATE_TOOLS = [
  { type: "function", function: { name: "bash" } },
  { type: "function", function: { name: "read" } },
];

const currentBody = (model) => ({
  model,
  max_tokens: 32000,
  stream: false,
  messages: [{ role: "user", content: "say OK" }],
});

const patchedBody = (model) => ({
  model,
  max_tokens: 32000,
  stream: true,
  messages: [{ role: "user", content: "say OK" }],
  tools: GATE_TOOLS,
});

function probe(label, headers, body) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: "opencode.ai", path: PATH, method: "POST", headers, timeout: 120000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const tag = res.statusCode === 200 ? "OK  " : "FAIL";
          console.log(`  [${res.statusCode}] ${tag} ${label}`);
          if (res.statusCode !== 200) console.log(`         ${data.slice(0, 100)}`);
          resolve(res.statusCode);
        });
      }
    );
    req.on("error", (e) => {
      console.log(`  [ERR ] ${label}: ${e.message}`);
      resolve(0);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(JSON.stringify(body));
    req.end();
  });
}

const current = [];
const patched = [];

console.log("=== CURRENT router behaviour (expect 403) ===");
for (const m of MODELS) current.push(await probe(`current/${m}`, CURRENT_HEADERS, currentBody(m)));

console.log("\n=== PATCHED behaviour (expect 200) ===");
for (const m of MODELS) patched.push(await probe(`patched/${m}`, PATCHED_HEADERS, patchedBody(m)));

const ok = current.every((s) => s === 403) && patched.every((s) => s === 200);
console.log(`\n  verdict: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
