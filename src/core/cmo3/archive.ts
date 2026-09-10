import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';

// CAFF layout follows ArchiveReader, ArchiveWriter and RandomAccess in the
// provided Editor 5.3.04 source. Integers are big endian, strings are UTF-8
// with a 7-bit big-endian length, and the archive key is XOR obfuscation.
export interface ArchiveEntry {
  path: string;
  tag: string;
  offset: number;
  size: number;
  obfuscated: boolean;
  compression: number;
  reserved: Buffer;
}

const HEADER_SIZE = 54;
const MAX_ENTRY_SIZE = 256 * 1024 * 1024;

export class Cmo3Archive {
  readonly entries: ArchiveEntry[] = [];
  readonly key: number;
  readonly format: string;
  readonly version: string;
  private readonly decoded = new Map<string, Buffer>();
  private resourceHash?: string;

  /** Start a native CAFF archive; resources then use the same directory writer. */
  static create(xml: string): Cmo3Archive {
    const header = Buffer.alloc(HEADER_SIZE);
    header.write('CAFF', 0, 'ascii');
    header.write('----', 7, 'ascii');
    header[26] = header[27] = 127;
    const names = Buffer.from('\x08main.xml\x08main_xml', 'ascii');
    const count = Buffer.alloc(4);
    count.writeInt32BE(1);
    const record = Buffer.alloc(22);
    record.writeBigInt64BE(BigInt(HEADER_SIZE + 4 + names.length + 22));
    record[13] = 33;
    const seed = new Cmo3Archive(Buffer.concat([header, count, names, record]));
    return new Cmo3Archive(seed.replace(new Map([['main.xml', Buffer.from(xml)]])));
  }

  constructor(readonly bytes: Buffer) {
    if (bytes.length < HEADER_SIZE + 4 || bytes.toString('ascii', 0, 4) !== 'CAFF') {
      throw new Error('Invalid CMO3: expected a CAFF archive.');
    }
    if (bytes[4] !== 0) throw new Error('Unsupported CAFF archive version.');
    this.key = bytes.readInt32BE(14);
    this.format = bytes.toString('ascii', 7, 11);
    this.version = [...bytes.subarray(4, 7)].join('.');
    let cursor = HEADER_SIZE;
    const requireBytes = (size: number) => {
      if (!Number.isSafeInteger(size) || size < 0 || cursor + size > bytes.length) {
        throw new Error('Truncated CMO3 archive directory.');
      }
    };
    const byte = () => {
      requireBytes(1);
      return bytes[cursor++] ^ (this.key & 255);
    };
    const int = () => {
      requireBytes(4);
      const n = bytes.readInt32BE(cursor) ^ this.key;
      cursor += 4;
      return n;
    };
    const long = () => {
      requireBytes(8);
      const n = bytes.readBigInt64BE(cursor) ^ ((BigInt(this.key) << 32n) | BigInt(this.key));
      cursor += 8;
      if (n < 0 || n > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('Invalid CMO3 entry offset.');
      return Number(n);
    };
    const string = () => {
      let length = 0;
      for (let i = 0; i < 4; i++) {
        const next = byte();
        length = length * 128 + (next & 127);
        if (next & 128) continue;
        requireBytes(length);
        if (length > 65536) throw new Error('CMO3 directory string is too long.');
        const text = Buffer.from(bytes.subarray(cursor, cursor + length));
        cursor += length;
        for (let j = 0; j < text.length; j++) text[j] ^= this.key & 255;
        return text.toString('utf8');
      }
      throw new Error('Invalid CMO3 string length.');
    };
    const count = int();
    if (count < 1 || count > 100000) throw new Error('Invalid CMO3 entry count.');
    const paths = new Set<string>();
    for (let i = 0; i < count; i++) {
      const path = string(),
        tag = string(),
        offset = long(),
        size = int();
      const obfuscated = byte() !== 0,
        compression = byte();
      requireBytes(8);
      const reserved = Buffer.from(bytes.subarray(cursor, cursor + 8));
      cursor += 8;
      if (paths.has(path)) throw new Error('Duplicate CMO3 archive entry.');
      if (![16, 33, 37].includes(compression)) throw new Error('Unsupported CMO3 compression.');
      this.checkRange(offset, size);
      paths.add(path);
      this.entries.push({ path, tag, offset, size, obfuscated, compression, reserved });
    }
    for (const entry of this.entries) {
      if (entry.offset < cursor) throw new Error('CMO3 entry overlaps the directory.');
    }
    const previewOffset = Number(bytes.readBigInt64BE(34));
    const previewSize = bytes.readInt32BE(42);
    if (previewOffset || previewSize) this.checkRange(previewOffset, previewSize);
  }

  private checkRange(offset: number, size: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      size < 0 ||
      size > MAX_ENTRY_SIZE ||
      offset + size > this.bytes.length
    ) {
      throw new Error('CMO3 entry is outside the archive or exceeds the size limit.');
    }
  }

  read(path: string): Buffer {
    let data = this.decoded.get(path);
    if (!data) {
      data = this.decode(path);
      this.decoded.set(path, data);
    }
    // Callers may edit returned bytes; the archive and its decode cache are immutable.
    return Buffer.from(data);
  }

  get payloadHash() {
    if (!this.resourceHash) {
      const hash = createHash('sha256');
      for (const entry of this.entries)
        if (entry.tag !== 'main_xml') {
          hash.update(entry.path);
          hash.update(this.bytes.subarray(entry.offset, entry.offset + entry.size));
        }
      this.resourceHash = hash.digest('hex');
    }
    return this.resourceHash;
  }

  private decode(path: string): Buffer {
    const entry = this.entries.find((e) => e.path === path);
    if (!entry) throw new Error(`CMO3 entry not found: ${path}`);
    const data = Buffer.from(this.bytes.subarray(entry.offset, entry.offset + entry.size));
    if (entry.obfuscated) for (let i = 0; i < data.length; i++) data[i] ^= this.key & 255;
    if (entry.compression === 16) return data;
    // Cubism writes a streaming ZIP local record; older files omit the central
    // directory. Read that record as ZipInputStream does, not as a ZIP archive.
    if (data.length < 30 || data.readUInt32LE(0) !== 0x04034b50)
      throw new Error('Invalid CMO3 ZIP record.');
    const start = 30 + data.readUInt16LE(26) + data.readUInt16LE(28);
    if (start > data.length || data.readUInt16LE(6) & 1)
      throw new Error('Invalid CMO3 ZIP header.');
    const method = data.readUInt16LE(8);
    if (method === 8) {
      const result = inflateRawSync(data.subarray(start), {
        maxOutputLength: MAX_ENTRY_SIZE,
        info: true,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      const consumed = result.engine.bytesWritten;
      let expectedCrc: number, expectedCompressed: number, expectedSize: number;
      if (data.readUInt16LE(6) & 8) {
        let descriptor = start + consumed;
        if (descriptor + 4 > data.length) throw new Error('Truncated CMO3 ZIP descriptor.');
        if (data.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
        if (descriptor + 12 > data.length) throw new Error('Truncated CMO3 ZIP descriptor.');
        expectedCrc = data.readUInt32LE(descriptor);
        expectedCompressed = data.readUInt32LE(descriptor + 4);
        expectedSize = data.readUInt32LE(descriptor + 8);
      } else {
        expectedCrc = data.readUInt32LE(14);
        expectedCompressed = data.readUInt32LE(18);
        expectedSize = data.readUInt32LE(22);
      }
      if (
        expectedSize !== result.buffer.length ||
        expectedCompressed !== consumed ||
        crc32(result.buffer) !== expectedCrc
      )
        throw new Error('Corrupt CMO3 ZIP entry (CRC or size mismatch).');
      return result.buffer;
    }
    if (method === 0) {
      const size = data.readUInt32LE(18);
      if (start + size > data.length) throw new Error('Truncated CMO3 ZIP record.');
      const result = data.subarray(start, start + size);
      if (crc32(result) !== data.readUInt32LE(14))
        throw new Error('Corrupt CMO3 ZIP entry (CRC mismatch).');
      return result;
    }
    throw new Error('Unsupported CMO3 ZIP method.');
  }

  get mainPath(): string {
    const entries = this.entries.filter((e) => e.tag === 'main_xml');
    if (entries.length !== 1) throw new Error('CMO3 must contain exactly one main_xml entry.');
    return entries[0].path;
  }

  get preview(): Buffer | null {
    const offset = Number(this.bytes.readBigInt64BE(34)),
      size = this.bytes.readInt32BE(42);
    return offset > 0 && size > 0 ? this.bytes.subarray(offset, offset + size) : null;
  }

  // Rebuild only the directory and changed entries. All unknown payloads,
  // flags, reserved bytes and the original XOR key survive unchanged.
  replace(replacements: Map<string, Buffer>): Buffer {
    if (!replacements.size) return Buffer.from(this.bytes);
    const entries = [...this.entries];
    for (const path of replacements.keys())
      if (!entries.some((e) => e.path === path)) {
        if (!/^[a-zA-Z0-9_.-]+\.png$/.test(path))
          throw new Error('New archive entries must be PNG images.');
        entries.push({
          path,
          tag: '',
          offset: 0,
          size: 0,
          compression: 16,
          obfuscated: true,
          reserved: Buffer.alloc(8),
        });
      }
    const encodedString = (value: string) => {
      const data = Buffer.from(value, 'utf8');
      let size = data.length;
      const prefix = [size & 127];
      while ((size = Math.floor(size / 128)) > 0) prefix.unshift((size & 127) | 128);
      const result = Buffer.concat([Buffer.from(prefix), data]);
      for (let i = 0; i < result.length; i++) result[i] ^= this.key & 255;
      return result;
    };
    const names = entries.map((e) => Buffer.concat([encodedString(e.path), encodedString(e.tag)]));
    let offset = HEADER_SIZE + 4 + names.reduce((n, v) => n + v.length + 22, 0);
    const payloads: Buffer[] = [],
      records: Buffer[] = [];
    entries.forEach((entry, i) => {
      const replacement = replacements.get(entry.path);
      let data: Buffer;
      if (replacement) {
        data =
          entry.compression === 16
            ? Buffer.from(replacement)
            : Buffer.from(
                zipSync({ contents: replacement }, { level: entry.compression === 33 ? 1 : 5 }),
              );
        if (entry.obfuscated) for (let j = 0; j < data.length; j++) data[j] ^= this.key & 255;
      } else data = this.bytes.subarray(entry.offset, entry.offset + entry.size);
      const record = Buffer.alloc(22);
      record.writeBigInt64BE(BigInt(offset) ^ ((BigInt(this.key) << 32n) | BigInt(this.key)), 0);
      record.writeInt32BE(data.length ^ this.key, 8);
      record[12] = Number(entry.obfuscated) ^ (this.key & 255);
      record[13] = entry.compression ^ (this.key & 255);
      entry.reserved.copy(record, 14);
      records.push(names[i], record);
      payloads.push(data);
      offset += data.length;
    });
    const header = Buffer.from(this.bytes.subarray(0, HEADER_SIZE));
    const preview = this.preview;
    if (preview) {
      header.writeBigInt64BE(BigInt(offset), 34);
      payloads.push(preview);
    }
    const count = Buffer.alloc(4);
    count.writeInt32BE(entries.length ^ this.key);
    return Buffer.concat([header, count, ...records, ...payloads]);
  }
}
