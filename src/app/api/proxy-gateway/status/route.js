import { NextResponse } from "next/server";
import net from "node:net";
import http from "node:http";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.PROXY_GATEWAY_URL || "http://127.0.0.1:8081";
const WARP_URL = process.env.WARP_PROXY_URL || "http://127.0.0.1:40000";

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function checkPort(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Egress IP melalui proxy HTTP (CONNECT tunnel) — dipakai utk cek WARP
function egressViaProxy(proxyHost, proxyPort, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: "api.ipify.org:443",
      headers: { Host: "api.ipify.org:443" },
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve(null);
      }
      socket.write(
        "GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n"
      );
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => {
        const m = data.match(/\r\n\r\n([\s\S]*)$/);
        resolve(m ? m[1].trim() : null);
      });
      socket.on("error", () => resolve(null));
    });
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(null));
    req.end();
  });
}

// GET /api/proxy-gateway/status — gateway 8081 pool health + WARP proxy status
export async function GET() {
  const [ips, warpPortOpen] = await Promise.all([
    fetchJson(`${GATEWAY_URL}/ips`),
    (() => {
      try {
        const u = new URL(WARP_URL);
        return checkPort(u.hostname, Number(u.port) || 40000);
      } catch {
        return false;
      }
    })(),
  ]);

  const pool = Array.isArray(ips?.ips) ? ips.ips : [];
  const alive = pool.filter((p) => p.status === "alive");
  const blocked = pool.filter((p) => p.status === "blocked");

  // Region summary dari sid (format sid-XXXX / region-XX-sid-XXXX)
  const regions = {};
  for (const p of pool) {
    const m = String(p.sid || "").match(/region-([A-Z]{2})/i);
    const region = m ? m[1].toUpperCase() : "any";
    regions[region] = (regions[region] || 0) + 1;
  }

  let warpEgress = null;
  if (warpPortOpen) {
    try {
      const u = new URL(WARP_URL);
      warpEgress = await egressViaProxy(u.hostname, Number(u.port) || 40000);
    } catch {
      warpEgress = null;
    }
  }

  return NextResponse.json({
    gateway: {
      url: GATEWAY_URL,
      online: !!ips,
      poolTotal: pool.length,
      alive: alive.length,
      blocked: blocked.length,
      regions,
      ips: pool,
    },
    warp: {
      url: WARP_URL,
      online: warpPortOpen,
      egressIp: warpEgress,
      note: "mode proxy — IP publik VPS tidak berubah",
    },
  });
}
