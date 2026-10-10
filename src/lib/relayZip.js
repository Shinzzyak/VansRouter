// Minimal ZIP writer for the Netlify function upload.
//
// Netlify's deploy API takes function code as a zip, so a relay deploy needs
// one. This builds only what that API accepts — stored/deflated entries, no
// zip64, no encryption, no directory records — which is a few dozen lines of
// framing around node:zlib. Pulling a zip library in for this would be a
// dependency for one call site.
//
// ponytail: no zip64 and no data descriptors; a relay function is a few KB, so
// the 4 GB / 65535-entry ceilings are unreachable. Revisit only if a payload
// ever approaches them.

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// entries: [{ name, data (string|Buffer) }]
export function buildZip(entries, { mtime = new Date() } = {}) {
  const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() / 2)) & 0xffff;
  const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff;

  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);        // version needed
    localHeader.writeUInt16LE(0, 6);         // flags
    localHeader.writeUInt16LE(8, 8);         // method: deflate
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(deflated.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);        // extra length

    local.push(localHeader, name, deflated);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);      // version made by
    centralHeader.writeUInt16LE(20, 6);      // version needed
    centralHeader.writeUInt16LE(0, 8);       // flags
    centralHeader.writeUInt16LE(8, 10);      // method
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(deflated.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);      // extra
    centralHeader.writeUInt16LE(0, 32);      // comment
    centralHeader.writeUInt16LE(0, 34);      // disk
    centralHeader.writeUInt16LE(0, 36);      // internal attrs
    centralHeader.writeUInt32LE(0, 38);      // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);

    offset += localHeader.length + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuf, end]);
}

// Netlify's file-digest is sha1 of the raw bytes, hex.
export function sha1Hex(buf) {
  return createHash("sha1").update(buf).digest("hex");
}
