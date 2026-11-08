// WireGuard import tests — real sudo round-trip against /etc/wireguard (0700
// root-only), same pattern as wireguard-manager.test.js. Runs only where
// passwordless sudo is available; skip otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execFileP = promisify(execFile);
const hasSudo = () =>
  execFileP("sudo", ["-n", "true"], { timeout: 10000 })
    .then(() => true)
    .catch(() => false);

const NAME = `wgimp${Date.now() % 1000000}`;
const GOOD_CONF = `[Interface]
Address = 10.99.0.2/32
PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
MTU = 1420

[Peer]
PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
Endpoint = 203.0.113.5:51820
AllowedIPs = 0.0.0.0/0
`;

let mgr;

beforeAll(async () => {
  if (await hasSudo()) {
    mgr = await import("@/lib/tunnel");
  }
}, 30000);

afterAll(async () => {
  if (!mgr) return;
  try {
    await execFileP("sudo", ["-n", "rm", "-f", `/etc/wireguard/${NAME}.conf`], { timeout: 15000 });
  } catch { /* already gone */ }
}, 30000);

describe("wireguard importProfile", () => {
  it("imports a valid config and surfaces it through listProfiles/readConf", async () => {
    if (!mgr) return;
    const meta = await mgr.importProfile(NAME, GOOD_CONF);
    expect(meta.name).toBe(NAME);
    expect(meta.endpoint).toBe("203.0.113.5:51820");
    expect(meta.peerCount).toBe(1);
    expect(meta.hasPrivateKey).toBe(true);

    const conf = await mgr.readConf(NAME);
    expect(conf.endpoint).toBe("203.0.113.5:51820");
    expect(conf.name).toBe(NAME);

    const profiles = await mgr.listProfiles();
    expect(profiles.some((p) => p.name === NAME)).toBe(true);
  }, 30000);

  it("rejects traversal / oversized / empty names before touching disk", async () => {
    if (!mgr) return;
    await expect(mgr.importProfile("../escape", GOOD_CONF)).rejects.toThrow(/Invalid profile name/);
    await expect(mgr.importProfile("a".repeat(40), GOOD_CONF)).rejects.toThrow(/Invalid profile name/);
    await expect(mgr.importProfile("", GOOD_CONF)).rejects.toThrow(/Invalid profile name/);
    await expect(mgr.importProfile("ok-name", "")).rejects.toThrow(/Missing config body/);
  });

  it("rejects a config that is not WireGuard (no [Interface]/[Peer])", async () => {
    if (!mgr) return;
    await expect(mgr.importProfile("bad-conf-1", "not a wg file\nrandom junk")).rejects.toThrow(/not a WireGuard|Import rejected/i);
    await expect(mgr.importProfile("bad-conf-2", "[Foo]\na=1\n")).rejects.toThrow(/not a WireGuard|Import rejected/i);
  });

  it("rejects an oversized config (64KB cap)", async () => {
    if (!mgr) return;
    await expect(mgr.importProfile("big-conf", "x".repeat(70 * 1024))).rejects.toThrow(/too large/);
  });

  it("rejects re-import over an existing profile (never clobbers a live conf)", async () => {
    if (!mgr) return;
    await expect(mgr.importProfile(NAME, GOOD_CONF)).rejects.toThrow(/already exists/);
  });
});
