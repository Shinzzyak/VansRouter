import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { getSettings, updateSettings } from "@/lib/localDb";

const execFileP = promisify(execFile);
const WG_DIR = "/etc/wireguard";
// Linux interface names are capped at 15 bytes (IFNAMSIZ-1); wg-quick enforces
// it even for `strip`, so the profile name IS the interface name ceiling.
const SAFE_NAME = /^[a-zA-Z0-9._-]{1,15}$/;

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
};

export function getWireguardService() {
  return svc;
}
export function isWireguardReconnecting() {
  return svc.spawnInProgress;
}

async function run(cmd, args) {
  // ponytail: passwordless root only; swap in the cached-password helper from
  // tailscale/manager if future deployments run passworded sudo.
  const base = ["-n", cmd, ...args];
  const { stdout, stderr } = await execFileP("sudo", base, { timeout: 25000 });
  return { stdout: String(stdout), stderr: String(stderr) };
}

const exists = (p) => fs.existsSync(p);

export async function listProfiles() {
  // /etc/wireguard is root-only (0700) so private keys stay protected; all
  // reads go through sudo, never raw fs on the router process uid.
  const res = await run("ls", ["-1", WG_DIR]).catch(() => null);
  if (!res) return [];
  const names = res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f.endsWith(".conf"))
    .map((f) => f.slice(0, -5))
    .filter((n) => SAFE_NAME.test(n));
  const out = [];
  for (const name of names) {
    try {
      out.push({ ...(await readConf(name)), file: `${WG_DIR}/${name}.conf` });
    } catch {
      out.push({ name, file: `${WG_DIR}/${name}.conf` });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readConf(name) {
  if (!SAFE_NAME.test(name)) throw new Error("Invalid WireGuard profile name.");
  const file = path.join(WG_DIR, `${name}.conf`);
  const { stdout: text } = await run("cat", [file]).catch((e) => {
    throw new Error(`Config /etc/wireguard/${name}.conf not found.`);
  });
  const endpoint =
    /^Endpoint\s*=\s*(\S+)/im.exec(text)?.[1] || "";
  const address = /^Address\s*=\s*([^\n]+)/im.exec(text)?.[1]?.trim() || "";
  const privateKey = /^PrivateKey\s*=\s*([^\n]+)/im.exec(text)?.[1] || "";
  const peerCount = (text.match(/^\[Peer\]/gm) || []).length;
  return { name, endpoint, address, peerCount, hasPrivateKey: !!privateKey };
}

export async function importProfile(name, confText) {
  if (!SAFE_NAME.test(name)) throw new Error("Invalid profile name (a-z A-Z 0-9 . _ - up to 15 chars, Linux interface limit).");
  if (typeof confText !== "string" || confText.length === 0)
    throw new Error("Missing config body.");
  if (confText.length > 64 * 1024)
    throw new Error("Config too large (max 64KB).");

  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 15);
  const finalPath = path.join(WG_DIR, `${safe}.conf`);
  // Short tmp basename: wg-quick strip parses the basename as an interface name.
  const tmpPath = `/tmp/wgrt${Date.now() % 100000000}.conf`;

  // Never pass conf content through the shell: write the temp file as the
  // router uid, validate with wg-quick strip (ground-truth parser via sudo),
  // and only then copy into the root-only dir. Refuse overwriting anything —
  // a live tunnel config must never be clobbered by a dashboard import.
  let alreadyExists = false;
  try {
    await run("ls", [finalPath]);
    alreadyExists = true;
  } catch { /* not present yet */ }
  if (alreadyExists)
    throw new Error(`Profile ${safe} already exists — delete ${safe}.conf first to re-import.`);

  try {
    fs.writeFileSync(tmpPath, confText, { mode: 0o600 });
  } catch (e) {
    throw new Error(`Temp write failed: ${e.message}`);
  }

  try {
    const strip = await run("wg-quick", ["strip", tmpPath]);
    const stripped = strip.stdout;
    if (!/^\s*\[Interface\]\s*$/m.test(stripped))
      throw new Error("Not a WireGuard config: missing [Interface].");
    if (!/^\s*\[Peer\]\s*$/m.test(stripped))
      throw new Error("Not a WireGuard config: missing [Peer].");
    if (!/^\s*PrivateKey\s*=/m.test(stripped))
      throw new Error("Config has no PrivateKey — refusing to import a peerless interface.");
    await run("cp", [tmpPath, finalPath]);
    await run("chmod", ["600", finalPath]);
  } catch (e) {
    // surface the semantic errors; fall back to raw sudo error text
    throw new Error(e.message.startsWith("Not a WireGuard") || e.message.startsWith("Config has no") ? e.message : `Import rejected: ${e.stderr || e.message}`);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch { /* temp already gone */ }
  }

  console.log(`[WireGuard] imported profile ${safe}`);
  return readConf(safe);
}

export async function startWireguard(profileName) {
  console.log(`[WireGuard] enable start (profile=${profileName})`);
  svc.created = Date.now();
  svc.spawnInProgress = true;
  try {
    const conf = await readConf(profileName);
    if (!conf.hasPrivateKey)
      throw new Error("Config has no PrivateKey — refusing to bring up a peerless interface.");
    await run("wg-quick", ["up", profileName]);
    await new Promise((r) => setTimeout(r, 250));
    // Verify the route actually moved onto the tunnel (full-tunnel conf: all traffic egresses via wg).
    const route = await run("ip", ["route", "get", "1.1.1.1"]);
    if (!route.stdout.includes(` dev ${profileName} `)) {
      await run("wg-quick", ["down", profileName]);
      throw new Error("Tunnel is up but egress routing did not switch to the WireGuard interface.");
    }
    await updateSettings({ wireguardEnabled: true, wireguardProfileName: profileName });
    const status = await describeInterface(profileName);
    console.log(
      `[WireGuard] enable success (endpoint=${conf.endpoint}, handshake=${status.handshake || "pending"})`
    );
    return { success: true, ...conf, handshake: status.handshake, rx: status.rx, tx: status.tx };
  } catch (e) {
    console.error(`[WireGuard] enable error: ${e.message}`);
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function stopWireguard() {
  console.log("[WireGuard] disable");
  svc.cancelToken.cancelled = true;
  const settings = await getSettings();
  const name = settings.wireguardProfileName;
  let downResult = null;
  if (name && SAFE_NAME.test(name)) {
    try {
      const r = await run("wg-quick", ["down", name]);
      downResult = { success: true, ...r };
    } catch (e) {
      // already down → fine
    }
  }
  await updateSettings({ wireguardEnabled: false, wireguardProfileName: "" });
  return { success: true, teardown: downResult };
}

async function describeInterface(name) {
  const res = await run("wg", ["show", name, "dump"]).catch(() => null);
  if (!res) return null;
  // wg dump: iface privkey pubkey listen fwmark; peer: pubkey preshared endpoint allowed-ips latest-handshake transfer-rx transfer-tx
  const lines = res.stdout.trim().split("\n");
  const iface = lines[0]?.split("\t") || [];
  const peer = lines[1]?.split("\t") || [];
  const handshakeTs = Number(peer[6] || 0);
  return {
    up: true,
    publicKey: iface[2] || "",
    listenPort: iface[3] || "",
    peer: peer[0] || "",
    endpoint: peer[2] || "",
    handshake: handshakeTs > 0 ? new Date(handshakeTs * 1000).toISOString() : "",
    rx: Number(peer[7] || 0),
    tx: Number(peer[8] || 0),
  };
}

export async function getWireguardStatus() {
  const settings = await getSettings();
  const enabled = settings.wireguardEnabled === true;
  const name = settings.wireguardProfileName || "";
  let conf = null;
  let ifaceInfo = null;
  if (name) {
    try {
      conf = await readConf(name);
    } catch {
      conf = null;
    }
    if (conf) ifaceInfo = await describeInterface(name);
  }
  return {
    enabled: enabled && !!ifaceInfo?.up,
    settingsEnabled: enabled,
    up: !!ifaceInfo?.up,
    profileName: name,
    conf,
    iface: ifaceInfo
      ? {
          publicKey: ifaceInfo.publicKey,
          listenPort: ifaceInfo.listenPort,
          endpoint: ifaceInfo.endpoint,
          handshake: ifaceInfo.handshake,
          rx: ifaceInfo.rx,
          tx: ifaceInfo.tx,
        }
      : null,
    egressIP: ifaceInfo?.up ? await probeEgress(name) : null,
  };
}

async function probeEgress(name) {
  const res = await run("curl", ["-sS", "--max-time", "6", "--interface", name, "https://api.ipify.org"]).catch(
    () => null
  );
  return res?.stdout?.trim() || null;
}
