// Unit tests for the per-pool WireGuard egress gate manager (conf parsing +
// inventory). Live provisioning (wg-quick up + gost) is NOT exercised here —
// that mutates host routing and needs a real tunnel profile.
//
// The conf path is redirected to a temp file via WG_GATE_CONF so the tests
// never touch a production /etc/wg-socks-gate.conf.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONF = path.join(os.tmpdir(), `gate-test-${process.pid}.conf`);
process.env.WG_GATE_CONF = CONF;
process.env.WG_GATE_SCRIPT = "/nonexistent/wg-socks-gate.sh";

const gate = await import("../../src/lib/tunnel/wireguard/gateManager.js");

beforeAll(() => {
  fs.writeFileSync(
    CONF,
    [
      "# gate conf — name:port:uid",
      "sg:11081:2001",
      "jp:11082:2002",
      "",
      "bad name:11083:2003", // space in name -> rejected
      "ok:80:2004", // port < 1024 -> rejected
      "ok2:11084:notanumber", // non-numeric uid -> rejected
      "toolonginterfacename:11085:2005", // > 15 chars -> rejected
    ].join("\n")
  );
});

afterAll(() => {
  try { fs.unlinkSync(CONF); } catch { /* gone */ }
});

describe("parseGateConf", () => {
  it("keeps only valid name:port:uid rows", () => {
    const rows = gate.parseGateConf(fs.readFileSync(CONF, "utf8"));
    expect(rows).toEqual([
      { name: "sg", port: 11081, uid: 2001 },
      { name: "jp", port: 11082, uid: 2002 },
    ]);
  });

  it("rejects bad names, out-of-range ports and non-numeric uids", () => {
    const { isPort, isUid, SAFE_NAME } = gate.__test__;
    expect(SAFE_NAME.test("bad name")).toBe(false);
    expect(SAFE_NAME.test("toolonginterfacename")).toBe(false);
    expect(isPort(80)).toBe(false);
    expect(isPort(11081)).toBe(true);
    expect(isUid("2001")).toBe(false);
    expect(isUid(2001)).toBe(true);
  });

  it("tolerates empty / junk input", () => {
    expect(gate.parseGateConf("")).toEqual([]);
    expect(gate.parseGateConf("onlyonenumber")).toEqual([]);
  });
});

describe("readGateConf", () => {
  it("reads and validates the redirected conf file", async () => {
    const rows = await gate.readGateConf();
    expect(rows.map((r) => r.name)).toEqual(["sg", "jp"]);
  });
});

describe("listGates", () => {
  it("returns inventory with socksUrl and non-secret fields only", async () => {
    const gates = await gate.listGates();
    expect(gates).toHaveLength(2);
    const sg = gates.find((g) => g.name === "sg");
    expect(sg.socksUrl).toBe("socks5://127.0.0.1:11081");
    expect(sg).toHaveProperty("up");
    expect(sg).toHaveProperty("table");
    // no secrets ever surface
    expect(JSON.stringify(gates)).not.toMatch(/PrivateKey|AAAAA/);
  });
});

describe("getGatesStatus", () => {
  it("reports conf presence and flags a missing provisioner script", async () => {
    const st = await gate.getGatesStatus();
    expect(st.confExists).toBe(true);
    expect(st.scriptExists).toBe(false); // WG_GATE_SCRIPT points at a nonexistent path
    expect(st.gates).toHaveLength(2);
  });
});
