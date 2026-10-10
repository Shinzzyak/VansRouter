// Credential vault — encryption at rest for provider secrets.
//
// The store is a JSON blob per connection (providerConnections.data). Instead of
// sealing the whole blob we seal the *values* of the secret fields and leave the
// JSON shape intact, so any reader that only wants `defaultModel` or `email`
// keeps working without knowing the vault exists, and a rotated or unreadable
// field degrades to "missing secret" instead of "unparseable row".
//
// ponytail: single-layer AES-256-GCM with a per-record scrypt salt, so rotating
// the master key is O(rows) re-encrypt instead of a DEK re-wrap. Swap in DEK
// wrapping if the connection table ever grows past a few thousand rows.
//
// Opt-in: with no master key configured the vault reports disabled and every
// read/write passes through untouched — existing installs keep their plaintext
// credentials and nothing breaks on upgrade.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

const PREFIX = "vault:v1:";
const KEY_LEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Fields whose value is a credential. Anything not listed stays readable.
export const SECRET_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "apiSecret",
  "clientSecret",
  "password",
  "privateKey",
  "sessionToken",
  "cookie",
  "cookies",
  "webhookSecret",
  "botToken",
  "serviceAccountKey",
];

export function masterKey() {
  const key = process.env.ROUTER_MASTER_KEY || process.env.VANSROUTER_MASTER_KEY || "";
  return key.trim();
}

export function vaultEnabled() {
  return masterKey().length > 0;
}

export function isSealed(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function deriveKey(master, salt) {
  return scryptSync(master, salt, KEY_LEN, SCRYPT_OPTS);
}

// "vault:v1:<salt b64>:<iv b64>:<tag b64>:<ciphertext b64>"
export function seal(plaintext, master = masterKey()) {
  if (plaintext === undefined || plaintext === null || plaintext === "") return plaintext;
  if (isSealed(plaintext)) return plaintext;
  if (!master) return plaintext;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(master, salt), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [salt, iv, tag, ct].map((b) => b.toString("base64")).join(":");
}

export function unseal(sealed, master = masterKey()) {
  if (!isSealed(sealed)) return sealed;
  if (!master) return null;
  const parts = sealed.slice(PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  try {
    const [salt, iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(master, salt), iv);
    decipher.setAuthTag(tag);
    // A wrong master key fails the GCM tag check here — that is the point.
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function verifyMasterKey(candidate) {
  const expected = masterKey();
  if (!expected || !candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(candidate));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Seal the secret fields of a connection payload. Returns a new object; a
// no-op (same reference) when the vault is off.
export function sealConnectionData(data) {
  if (!data || typeof data !== "object" || !vaultEnabled()) return data;
  let changed = false;
  const out = { ...data };
  for (const field of SECRET_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value && !isSealed(value)) {
      out[field] = seal(value);
      changed = true;
    }
  }
  return changed ? out : data;
}

// Reverse of sealConnectionData. Unreadable fields are dropped rather than left
// as ciphertext, so a caller can never ship a sealed blob upstream as if it were
// a token; `unreadable` names them for the dashboard.
export function unsealConnectionData(data, out = {}) {
  if (!data || typeof data !== "object") return { data, unreadable: [] };
  const unreadable = [];
  const copy = { ...data };
  for (const field of SECRET_FIELDS) {
    const value = copy[field];
    if (!isSealed(value)) continue;
    const plain = unseal(value);
    if (plain === null) {
      delete copy[field];
      unreadable.push(field);
    } else {
      copy[field] = plain;
    }
  }
  if (unreadable.length && out) out.unreadable = unreadable;
  return { data: copy, unreadable };
}
