// SSRF guard: block internal/private/metadata targets for server-side fetch.

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];
const PUBLIC_PROTOCOLS = new Set(["http:", "https:"]);

// Parse dotted IPv4 to 32-bit integer, or null if not a valid IPv4 literal.
function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Private/reserved IPv4 ranges as [startInt, maskBits].
const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16],
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("100.64.0.0"), 10],
  [ipv4ToInt("224.0.0.0"), 4],
];

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isBlockedIpv4(v4Mapped[1]);
  if (h === "::1" || h === "::") return true;
  return h.startsWith("::ffff:") || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd");
}

// Throw if URL targets a non-public host. Caller should map to 400.
export function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();

  if (!PUBLIC_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Blocked URL: unsupported target");
  }
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error("Blocked URL: internal host");
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new Error("Blocked URL: internal host");
  if (isBlockedIpv4(host)) throw new Error("Blocked URL: private IP");
  if (host.includes(":") && isBlockedIpv6(host)) throw new Error("Blocked URL: private IP");
}

// Source embedded in edge/serverless relays; keep it dependency-free.
export const RELAY_TARGET_GUARD_SOURCE = `function assertTrustedTarget(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Blocked URL: unsupported target");
  }
  if (["localhost", "ip6-localhost", "ip6-loopback"].includes(host) ||
      host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new Error("Blocked URL: internal host");
  }
  const ipv4 = host.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const ip = ipv4.reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
    const blocked = [[0, 8], [167772160, 8], [2130706432, 8], [2851995648, 16], [2852039168, 12], [2886729728, 12], [3232235520, 16], [1681915904, 10], [3758096384, 4]];
    if (blocked.some(([base, bits]) => (ip & ((0xffffffff << (32 - bits)) >>> 0)) === (base & ((0xffffffff << (32 - bits)) >>> 0)))) {
      throw new Error("Blocked URL: private IP");
    }
  }
  const ipv6 = host.replace(/^\\[|\\]$/g, "").toLowerCase();
  if (ipv6 === "::" || ipv6 === "::1" || ipv6.startsWith("::ffff:") || ipv6.startsWith("fe80:") || ipv6.startsWith("fc") || ipv6.startsWith("fd")) {
    throw new Error("Blocked URL: private IP");
  }
}`;
