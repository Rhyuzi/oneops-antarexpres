"use strict";

/**
 * Minimal streaming ZIP writer (no dependency, Node 14+) for Data Warrior
 * "Download all from folder".
 *
 * - STORED entries (no compression: documents/images are mostly compressed
 *   already, and the server never holds more than one file in memory).
 * - Each entry is buffered once to compute its CRC-32, then written with its
 *   real sizes in the local header (no data descriptor → opens everywhere:
 *   Windows Explorer, macOS Archive Utility, 7-Zip, unzip).
 * - UTF-8 file names (general purpose flag bit 11).
 * - Classic ZIP (32-bit offsets): the caller keeps the total below ~4 GB
 *   (the route limits it to MAX_ZIP_BYTES).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** JS Date → [dosTime, dosDate] (local time, 2-second resolution). */
function dosDateTime(d) {
  const date = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const year = Math.max(1980, date.getFullYear());
  return [
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  ];
}

/** Readable stream / Buffer / Uint8Array → Buffer. */
async function toBuffer(source) {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) return Buffer.from(source);
  if (source && typeof source.transformToByteArray === "function") return Buffer.from(await source.transformToByteArray());
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Writes to a Node writable (an HTTP response) and resolves on drain. */
function writeTo(out, buf) {
  return new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error("client disconnected"));
    if (out.write(buf)) resolve();
    else {
      out.once("drain", resolve);
      out.once("error", reject);
    }
  });
}

/**
 * Archive path safety: forward slashes, no leading "/", no "." / ".." parts,
 * no control or Windows-reserved characters.
 */
function safeEntryName(name) {
  return String(name || "file")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim())
    .filter((p) => p && p !== "." && p !== "..")
    .join("/") || "file";
}

function createZip(out) {
  const entries = [];
  let offset = 0;

  return {
    /** Adds one file (name may contain "/" for sub-folders). */
    async addFile(name, source, { date = new Date() } = {}) {
      const data = await toBuffer(source);
      const fileName = Buffer.from(safeEntryName(name), "utf8");
      const crc = crc32(data);
      const [time, dosDate] = dosDateTime(date);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); // local file header
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(dosDate, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(fileName.length, 26);
      header.writeUInt16LE(0, 28);
      await writeTo(out, header);
      await writeTo(out, fileName);
      await writeTo(out, data);
      entries.push({ fileName, crc, size: data.length, time, dosDate, offset });
      offset += header.length + fileName.length + data.length;
      return data.length;
    },
    /** Central directory + end record. */
    async finish() {
      const start = offset;
      let size = 0;
      for (const e of entries) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0); // central directory header
        h.writeUInt16LE(20, 4); // version made by
        h.writeUInt16LE(20, 6); // version needed
        h.writeUInt16LE(0x0800, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(e.time, 12);
        h.writeUInt16LE(e.dosDate, 14);
        h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(e.size, 20);
        h.writeUInt32LE(e.size, 24);
        h.writeUInt16LE(e.fileName.length, 28);
        h.writeUInt16LE(0, 30); // extra
        h.writeUInt16LE(0, 32); // comment
        h.writeUInt16LE(0, 34); // disk
        h.writeUInt16LE(0, 36); // internal attrs
        h.writeUInt32LE(0, 38); // external attrs
        h.writeUInt32LE(e.offset, 42);
        await writeTo(out, h);
        await writeTo(out, e.fileName);
        size += h.length + e.fileName.length;
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(0, 4);
      end.writeUInt16LE(0, 6);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(size, 12);
      end.writeUInt32LE(start, 16);
      end.writeUInt16LE(0, 20);
      await writeTo(out, end);
      return { files: entries.length, bytes: offset };
    },
  };
}

module.exports = { createZip, crc32, safeEntryName, dosDateTime };
