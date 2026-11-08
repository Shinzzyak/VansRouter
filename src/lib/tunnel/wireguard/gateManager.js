// Per-pool WireGuard egress gates — inventory + provision/teardown for the
// local SOCKS5 listeners created by ops/wg-socks-gate.sh.
//
// Each gate = one WireGuard tunnel + one gost SOCKS5 listener bound to
// 127.0.0.1:<port>, running under a dedicated uid. An `ip rule uidrange <uid>`
// steers that daemon's packets into the tunnel's routing table, so a proxy pool
// pointed at the gate egresses through the tunnel — with ZERO router/engine
// code change (the existing proxy-pool system in connectionProxy.js just reads
// pool.proxyUrl).
//
// Additive infra only. Secrets never leave the box: only name/port/uid/up state
// is returned — never conf body, keys, or tunnel internals.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

// Conf path is overridable so unit tests never touch a live production file.
const GATE_CONF = process.env.WG_GATE_CONF || "/etc/wg-socks-gate.conf";
// Provisioner script lives in the repo that is deployed to the host.
const GATE_SCRIPT =
  process.env.WG_GATE_SCRIPT || path.resolve(process.cwd(), "ops/wg-socks-gate.sh");

const SAFE_NAME = /^[a-zA-Z0-9._-]{1,15}$/; // Linux IFNAMSIZ-1, matches manager.js
const isPort = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
const isUid = (u) => Number.isInteger(u) && u >= 100 && u <= 60000;

async function run(cmd, args, timeout = 20000) {
  const { stdout, stderr } = await execFileP("sudo", ["-n", cmd, ...args], { timeout });
  return { stdout: String(stdout), stderr: String(stderr) };
}

// Parse `name:port:uid` lines; drop blanks/comments; reject malformed rows
// rather than surfacing attacker-influenced strings to the UI.
export function parseGateConf(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length !== 3) continue;
    const name = parts[0].trim();
    const port = Number(parts[1].trim());
    const uid = Number(parts[2].trim());
    if (!SAFE_NAME.test(name) || !isPort(port) || !isUid(uid)) continue;
    out.push({ name, port, uid });
  }
  return out;
}

export async function readGateConf() {
  const res = await run("cat", [GATE_CONF]).catch(() => null);
  if (!res) return [];
  return parseGateConf(res.stdout);
}

// Active-unit set from systemd (one call), port set from ss (one call), and the
// uid-rule map from `ip rule show` (one call) — avoids N+1 per gate.
async function hostState() {
  const [units, ss, rules] = await Promise.all([
    run("bash", ["-c", "systemctl list-units --no-legend --plain 'gst-*.service' 2>/dev/null | awk '{print $1\"|\"$4}'"]).catch(() => null),
    run("ss", ["-lntH"]).catch(() => null),
    run("ip", ["rule", "show"]).catch(() => null),
  ]);

  const unitState = new Map(); // "gst-<name>.service" → active|inactive
  for (const l of (units?.stdout || "").split("\n")) {
    const [u, s] = l.trim().split("|");
    if (u && s) unitState.set(u, s);
  }
  const listeningPorts = new Set();
  for (const l of (ss?.stdout || "").split("\n")) {
    const m = /:(\d+)\s+\S+$|:(\d+)\s/.exec(l.trim());
    const port = Number(m?.[1] || m?.[2] || 0);
    if (port) listeningPorts.add(port);
  }
  const ruledUids = new Map(); // uid → table
  for (const l of (rules?.stdout || "").split("\n")) {
    const m = /uidrange\s+(\d+)-(\d+)\s+lookup\s+(\d+)/.exec(l);
    if (m) ruledUids.set(Number(m[1]), Number(m[3]));
  }
  return { unitState, listeningPorts, ruledUids };
}

export async function listGates() {
  const entries = await readGateConf();
  if (entries.length === 0) return [];
  const { unitState, listeningPorts, ruledUids } = await hostState();
  return entries.map(({ name, port, uid }) => {
    const unit = `gst-${name}.service`;
    const unitActive = unitState.get(unit) === "active";
    const listening = listeningPorts.has(port);
    const table = ruledUids.get(uid) || null;
    return {
      name,
      port,
      uid,
      socksUrl: `socks5://127.0.0.1:${port}`,
      table,
      unit: unitActive,
      listening,
      // Fully wired = daemon active, listener bound, uid rule installed.
      up: unitActive && listening && table !== null,
    };
  });
}

export function gatesScriptPath() {
  return GATE_SCRIPT;
}

async function callScript(action) {
  // The provisioner is idempotent and never touches the router process; it only
  // provisions/tears down gates defined in the conf.
  return run("bash", [GATE_SCRIPT, action], 60000);
}

export async function provisionGates() {
  const r = await callScript("up");
  return { success: true, output: r.stdout.trim().slice(0, 4000) };
}

export async function teardownGates() {
  const r = await callScript("down");
  return { success: true, output: r.stdout.trim().slice(0, 4000) };
}

export async function getGatesStatus() {
  const confExists = await run("test", ["-f", GATE_CONF]).then(() => true).catch(() => false);
  const scriptExists = await run("test", ["-x", GATE_SCRIPT]).then(() => true).catch(() => false);
  return {
    confPath: GATE_CONF,
    confExists,
    scriptExists,
    gates: confExists ? await listGates() : [],
  };
}

export const __test__ = { parseGateConf, SAFE_NAME, isPort, isUid };
