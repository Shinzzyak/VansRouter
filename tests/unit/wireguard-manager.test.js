// Unit tests for the WireGuard global-egress manager (conf parsing + profile
// listing + name validation). Live wg-quick bring-up is NOT exercised here —
// that path mutates host routing and needs a real peer config.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue({}),
}));

const exec = promisify(execFile);

const mgr = await import("../../src/lib/tunnel/wireguard/manager.js");

const CONF = [
  "[Interface]",
  "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "Address = 10.9.0.2/24",
  "DNS = 10.9.0.1",
  "",
  "[Peer]",
  "PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  "AllowedIPs = 0.0.0.0/0",
  "Endpoint = vpn.example.com:51820",
  "",
].join("\n");

beforeAll(async () => {
  fs.writeFileSync("/tmp/unit-test-wg.conf", CONF);
  await exec("sudo", ["-n", "mkdir", "-p", "/etc/wireguard"], { timeout: 20000 });
  await exec("sudo", ["-n", "cp", "/tmp/unit-test-wg.conf", "/etc/wireguard/unit-test-wg.conf"], {
    timeout: 20000,
  });
}, 30000);

afterAll(async () => {
  await exec("sudo", ["-n", "rm", "-f", "/etc/wireguard/unit-test-wg.conf", "/tmp/unit-test-wg.conf"], {
    timeout: 20000,
  });
}, 30000);

describe("readConf", () => {
  it("parses endpoint, address, peers and private key presence", async () => {
    const c = await mgr.readConf("unit-test-wg");
    expect(c.name).toBe("unit-test-wg");
    expect(c.endpoint).toBe("vpn.example.com:51820");
    expect(c.address).toBe("10.9.0.2/24");
    expect(c.peerCount).toBe(1);
    expect(c.hasPrivateKey).toBe(true);
  });

  it("throws on missing conf", async () => {
    await expect(mgr.readConf("no-such-profile")).rejects.toThrow(/not found/);
  });

  it("rejects path traversal and oversized names before touching the FS", async () => {
    await expect(mgr.readConf("../etc/passwd")).rejects.toThrow(/Invalid/);
    await expect(mgr.readConf("a".repeat(40))).rejects.toThrow(/Invalid/);
    await expect(mgr.readConf("")).rejects.toThrow(/Invalid/);
  });
});

describe("listProfiles", () => {
  it("enumerates /etc/wireguard/*.conf and parses each", async () => {
    const profiles = await mgr.listProfiles();
    const found = profiles.find((p) => p.name === "unit-test-wg");
    expect(found).toBeTruthy();
    expect(found.endpoint).toBe("vpn.example.com:51820");
  });
});
