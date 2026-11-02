// Minimal PNG codec (8-bit, non-interlaced) so the video tool has no npm
// dependency. Only what LPC sheets need: decode to RGBA, encode from RGBA.
import { deflateSync, inflateSync } from "node:zlib";

/** Raw 8-bit RGBA image. */
export type Raster = {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG into RGBA pixels. Throws on formats LPC sheets never use. */
export function decodePng(input: Uint8Array): Raster {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (input[i] !== SIGNATURE[i]) throw new Error("bukan berkas PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= input.length) {
    const length = readU32(input, offset);
    const type = String.fromCharCode(
      input[offset + 4],
      input[offset + 5],
      input[offset + 6],
      input[offset + 7],
    );
    const start = offset + 8;
    const chunk = input.subarray(start, start + length);

    if (type === "IHDR") {
      width = readU32(chunk, 0);
      height = readU32(chunk, 4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "PLTE") {
      palette = chunk;
    } else if (type === "tRNS") {
      transparency = chunk;
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }

    offset = start + length + 4;
  }

  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error(`PNG colour type ${colorType} is not supported`);
  }
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8) {
    throw new Error(`bit depth ${bitDepth} is not supported (1, 2, 4, or 8)`);
  }
  // Sub-byte depths only exist for grayscale and palette images (PNG spec),
  // which is exactly what the older 4bpp LPC sheets use.
  if (bitDepth < 8 && colorType !== 0 && colorType !== 3) {
    throw new Error(
      `combination of colour type ${colorType} and ${bitDepth}-bit is not supported`,
    );
  }
  if (colorType === 3 && palette === null) {
    throw new Error("PNG palet tanpa PLTE");
  }
  const bitsPerPixel = channels * bitDepth;
  /** Byte distance between filtered samples (minimum 1 byte). */
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

  let total = 0;
  for (const part of idat) total += part.length;
  const compressed = new Uint8Array(total);
  let cursor = 0;
  for (const part of idat) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const inflated = new Uint8Array(inflateSync(compressed));

  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const pixels = new Uint8Array(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = inflated[src++];
      const a = x >= bpp ? pixels[row + x - bpp] : 0;
      const b = y > 0 ? pixels[prev + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[prev + x - bpp] : 0;
      let out: number;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth(a, b, c);
      else throw new Error(`PNG filter ${filter} is not supported`);
      pixels[row + x] = out & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  const maxSample = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      // Sub-byte samples are packed big-endian within each byte.
      const sample = (channel: number): number => {
        if (bitDepth === 8) return pixels[row + x * channels + channel];
        const bitPosition = x * bitDepth;
        const byte = pixels[row + (bitPosition >> 3)];
        return (byte >> (8 - bitDepth - (bitPosition & 7))) & maxSample;
      };
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 0) {
        r = g = b = Math.round((sample(0) * 255) / maxSample);
      } else if (colorType === 2) {
        r = sample(0);
        g = sample(1);
        b = sample(2);
      } else if (colorType === 3) {
        const index = sample(0);
        if (index * 3 + 2 >= palette!.length)
          throw new Error("PNG palette index outside PLTE");
        r = palette![index * 3];
        g = palette![index * 3 + 1];
        b = palette![index * 3 + 2];
        a =
          transparency !== null && index < transparency.length
            ? transparency[index]
            : 255;
      } else if (colorType === 4) {
        r = g = b = sample(0);
        a = sample(1);
      } else {
        r = sample(0);
        g = sample(1);
        b = sample(2);
        a = sample(3);
      }
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }

  return { width, height, data };
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  view.setUint32(
    8 + payload.length,
    crc32(out.subarray(4, 8 + payload.length)),
  );
  return out;
}

/** Encode RGBA pixels as a PNG (filter 0, single IDAT). */
export function encodePng(raster: Raster): Uint8Array {
  const { width, height, data } = raster;
  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (rowBytes + 1);
    raw[dst] = 0;
    raw.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];

  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
