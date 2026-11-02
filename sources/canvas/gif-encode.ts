// Minimal GIF89a encoder (animated, transparent, looping) used by the
// in-browser "Animation (GIF)" export. This mirrors `tools/video/gif.ts`
// (the Node CLI encoder) on purpose: pixel art usually fits an exact
// 255-colour palette, and anything larger is median-cut quantised first.
// Keep the two implementations in sync when fixing bugs in either.

type Rgb = readonly [number, number, number];

/** One raw RGBA bitmap, same shape as the CLI `Raster` in `tools/video/png.ts`. */
export type GifFrame = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
};

const TRANSPARENT_ALPHA = 128;

function toRgb(key: number): Rgb {
  return [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
}

function channelRange(
  colors: readonly { key: number }[],
  shift: number,
): number {
  let lo = 255;
  let hi = 0;
  for (const color of colors) {
    const value = (color.key >> shift) & 0xff;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return hi - lo;
}

/** Median-cut quantise down to at most `max` palette entries. */
function quantize(
  colors: readonly { key: number; count: number }[],
  max: number,
): Rgb[] {
  let boxes: { key: number; count: number }[][] = [colors.slice()];

  while (boxes.length < max) {
    let target = -1;
    let widest = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      let range = 0;
      for (let shift = 0; shift <= 16; shift += 8) {
        range = Math.max(range, channelRange(boxes[i], shift));
      }
      if (range > widest) {
        widest = range;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    let bestShift = 0;
    let bestRange = -1;
    for (let shift = 0; shift <= 16; shift += 8) {
      const range = channelRange(box, shift);
      if (range > bestRange) {
        bestRange = range;
        bestShift = shift;
      }
    }

    const sorted = box
      .slice()
      .sort(
        (a, b) => ((a.key >> bestShift) & 0xff) - ((b.key >> bestShift) & 0xff),
      );
    const middle = Math.floor(sorted.length / 2);
    boxes = [
      ...boxes.slice(0, target),
      sorted.slice(0, middle),
      sorted.slice(middle),
      ...boxes.slice(target + 1),
    ];
  }

  return boxes
    .filter((box) => box.length > 0)
    .map((box) => {
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (const entry of box) {
        const [pr, pg, pb] = toRgb(entry.key);
        r += pr * entry.count;
        g += pg * entry.count;
        b += pb * entry.count;
        total += entry.count;
      }
      return [
        Math.round(r / total),
        Math.round(g / total),
        Math.round(b / total),
      ] as Rgb;
    });
}

function nearest(
  palette: readonly Rgb[],
  r: number,
  g: number,
  b: number,
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** LZW-compress colour indices for one GIF frame. */
function lzw(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out: number[] = [];
  let bits = 0;
  let bitCount = 0;

  const emit = (code: number, size: number): void => {
    bits |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  };

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let table = new Map<number, number>();
  emit(clearCode, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const next = indices[i];
    const key = (prefix << 8) | next;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix, codeSize);
    if (nextCode < 4096) {
      table.set(key, nextCode++);
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clearCode, codeSize);
      table = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = next;
  }

  emit(prefix, codeSize);
  emit(endCode, codeSize);
  if (bitCount > 0) out.push(bits & 0xff);
  return out;
}

function pushSubBlocks(out: number[], bytes: number[]): void {
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.slice(i, i + 255);
    out.push(slice.length, ...slice);
  }
  out.push(0);
}

/** Encode RGBA frames as an animated, looping GIF. */
export function encodeGif(
  frames: readonly GifFrame[],
  delaysCs: readonly number[],
): Uint8Array {
  if (frames.length === 0) throw new Error("no frames to encode as a GIF");

  const width = frames[0].width;
  const height = frames[0].height;
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error("all frames must be the same size");
    }
  }

  const counts = new Map<number, number>();
  let hasTransparency = false;
  for (const frame of frames) {
    const { data } = frame;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] < TRANSPARENT_ALPHA) {
        hasTransparency = true;
        continue;
      }
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const entries = [...counts.entries()].map(([key, count]) => ({ key, count }));
  const limit = hasTransparency ? 254 : 255;
  const lookup = new Map<number, number>();
  let palette: Rgb[];

  if (entries.length <= limit) {
    palette = entries.map((entry) => toRgb(entry.key));
    entries.forEach((entry, index) => lookup.set(entry.key, index));
  } else {
    palette = quantize(entries, limit);
    for (const entry of entries) {
      const [r, g, b] = toRgb(entry.key);
      lookup.set(entry.key, nearest(palette, r, g, b));
    }
  }

  // Colour table slot 0 is the transparent sentinel, so real palette entries
  // always start at index 1 — for opaque animations too (opaque frames never
  // reference index 0).
  const offset = 1;
  const out: number[] = [];

  // Header + logical screen descriptor (256-entry global colour table).
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  out.push(
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    0xf7,
    0,
    0,
  );
  out.push(0, 0, 0); // index 0: transparent slot (or unused padding)
  for (const [r, g, b] of palette) out.push(r, g, b);
  for (let i = palette.length; i < 255; i++) out.push(0, 0, 0);

  // Netscape looping extension: repeat forever.
  out.push(0x21, 0xff, 0x0b);
  for (const char of "NETSCAPE2.0") out.push(char.charCodeAt(0));
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (let f = 0; f < frames.length; f++) {
    const delay = Math.max(2, Math.round(delaysCs[f] ?? 10));
    // Disposal 2 (restore background) keeps transparent frames from ghosting.
    out.push(
      0x21,
      0xf9,
      0x04,
      (2 << 2) | (hasTransparency ? 1 : 0),
      delay & 0xff,
      (delay >> 8) & 0xff,
      0,
      0,
    );
    out.push(
      0x2c,
      0,
      0,
      0,
      0,
      width & 0xff,
      (width >> 8) & 0xff,
      height & 0xff,
      (height >> 8) & 0xff,
      0,
    );

    const { data } = frames[f];
    const indices = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < indices.length; i++, p += 4) {
      if (data[p + 3] < TRANSPARENT_ALPHA) {
        indices[i] = 0;
        continue;
      }
      const index = lookup.get(
        (data[p] << 16) | (data[p + 1] << 8) | data[p + 2],
      );
      indices[i] = index === undefined ? 0 : index + offset;
    }

    out.push(8); // LZW minimum code size
    pushSubBlocks(out, lzw(indices, 8));
  }

  out.push(0x3b);
  return Uint8Array.from(out);
}
