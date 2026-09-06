// Minimal in-process ZIP encoder.
//
// Why not add a dependency
//   The only place we produce a zip is the diagnostics-bundle endpoint, and
//   the bundle is a handful of small text files (server.log, server.log.1,
//   bundle-info.txt). Pulling in `archiver` or `adm-zip` for a single
//   endpoint - along with their transitive deps - felt disproportionate.
//   The core ZIP format needed for that use case (STORED entries and
//   DEFLATE-compressed entries, with a central directory) is a couple
//   hundred lines of Node using only `node:zlib`.
//
// What this supports
//   - Multiple entries, each in-memory (Buffer) with a filename
//   - Optional per-entry compression (DEFLATE) - we pick the smaller of
//     STORED and DEFLATE per entry
//   - CRC32 over the raw contents
//   - Local file header + central directory + end-of-central-directory
//
// What it deliberately does not support
//   - ZIP64 (files >4 GB or >65535 entries)
//   - Encryption / passwords
//   - Timestamps other than the current build time
//   - Directory entries (all filenames are file entries; use forward slashes
//     for path separators in the name if you want a nested layout)
//   - UTF-8 filenames beyond ASCII - the general-purpose bit for UTF-8
//     names IS set, but callers should stick to plain ASCII names.
//
// The output has been spot-checked against `unzip -l` and Windows Explorer
// on typical inputs (log text, small JSON). If we ever need something more
// exotic, swap in archiver.

import { deflateRawSync } from "node:zlib";

// -------- CRC32 --------
// Standard CRC-32 (poly 0xEDB88320). We precompute the byte table once at
// module load so per-entry checksum work is a straight table lookup.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// -------- DOS date/time --------
// ZIP stores mtime as an MS-DOS packed date + time. We use "now" for every
// entry which is fine for a diagnostics bundle - the actual log file mtime
// is not something a maintainer cares about here.
function dosDateTime(now = new Date()): { date: number; time: number } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const hour = now.getHours();
  const min = now.getMinutes();
  const sec = Math.floor(now.getSeconds() / 2); // DOS time has 2s resolution
  const date = ((year - 1980) << 9) | (month << 5) | day;
  const time = (hour << 11) | (min << 5) | sec;
  return { date, time };
}

// -------- Public API --------
export interface ZipEntry {
  name: string; // ASCII filename inside the zip
  data: Buffer | string; // raw contents
}

/**
 * Build a ZIP archive from an array of in-memory entries. Returns the full
 * zip buffer synchronously - all entries live in RAM anyway, so streaming
 * the output would not save memory.
 *
 * Each entry is compressed with DEFLATE, and we fall back to STORED if the
 * compressed form is not actually smaller (short text or already-compressed
 * bytes).
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0; // running byte offset of the next local file header

  const { date: dosDate, time: dosTime } = dosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const crc = crc32(raw);

    // Try DEFLATE, fall back to STORED if it doesn't help. deflateRawSync
    // produces raw deflate (no zlib header) which is what ZIP wants.
    let method = 0; // 0 = STORED, 8 = DEFLATE
    let payload = raw;
    const deflated = deflateRawSync(raw);
    if (deflated.length < raw.length) {
      method = 8;
      payload = deflated;
    }

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8 name)
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);

    localParts.push(local, payload);

    // Central directory entry (46 bytes + name)
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // gp flag
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);

    centralParts.push(central);

    // Advance running offset by the size of the local header + name + payload.
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const centralOffset = offset;
  const centralSize = centralBuf.length;

  // End of central directory record (22 bytes, no zip comment)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // zip comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}
