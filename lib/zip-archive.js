const { deflateRawSync } = require("zlib");

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function createZipArchive(entries, modifiedAt = new Date()) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("ZIP archive requires at least one file.");
  if (entries.length > 0xffff) throw new Error("ZIP archive contains too many files.");
  const localParts = [];
  const centralParts = [];
  const { dosDate, dosTime } = dosTimestamp(modifiedAt);
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name || "file.json"), "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ""), "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);
    if (name.length > 0xffff) throw new Error("ZIP file name is too long.");
    assertZip32(content.length, "file");
    assertZip32(compressed.length, "compressed file");
    assertZip32(offset, "archive offset");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localDirectory = Buffer.concat(localParts);
  assertZip32(centralDirectory.length, "central directory");
  assertZip32(localDirectory.length, "archive");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localDirectory.length, 16);
  return Buffer.concat([localDirectory, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(value) {
  const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function assertZip32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`ZIP ${label} is too large.`);
}

module.exports = { createZipArchive };
