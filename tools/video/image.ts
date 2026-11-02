// Pixel operations shared by the video tools. Everything works on RGBA rasters
// from ./png.ts and stays allocation-light: frame counts here are tiny.
import type { Raster } from "./png.ts";

export type Rgb = readonly [number, number, number];

/** Copy a rectangle out of a raster. */
export function crop(
  source: Raster,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * source.width + x0) * 4;
    data.set(source.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** Nearest-neighbour upscale, so pixel art keeps hard edges. */
export function scaleNearest(source: Raster, factor: number): Raster {
  if (factor === 1) return source;
  const width = source.width * factor;
  const height = source.height * factor;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / factor);
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      data[to] = source.data[from];
      data[to + 1] = source.data[from + 1];
      data[to + 2] = source.data[from + 2];
      data[to + 3] = source.data[from + 3];
    }
  }
  return { width, height, data };
}

/** Composite onto an opaque background colour. */
export function flatten(source: Raster, rgb: Rgb): Raster {
  const data = new Uint8Array(source.data.length);
  for (let p = 0; p < source.data.length; p += 4) {
    const alpha = source.data[p + 3] / 255;
    data[p] = Math.round(source.data[p] * alpha + rgb[0] * (1 - alpha));
    data[p + 1] = Math.round(source.data[p + 1] * alpha + rgb[1] * (1 - alpha));
    data[p + 2] = Math.round(source.data[p + 2] * alpha + rgb[2] * (1 - alpha));
    data[p + 3] = 255;
  }
  return { width: source.width, height: source.height, data };
}

/** Tile frames into a grid, left to right then top to bottom. */
export function composeGrid(
  frames: readonly Raster[],
  columns: number,
): Raster {
  const width = frames[0].width * columns;
  const rows = Math.ceil(frames.length / columns);
  const height = frames[0].height * rows;
  const data = new Uint8Array(width * height * 4);
  frames.forEach((frame, index) => {
    const x0 = (index % columns) * frame.width;
    const y0 = Math.floor(index / columns) * frame.height;
    for (let y = 0; y < frame.height; y++) {
      const to = ((y0 + y) * width + x0) * 4;
      data.set(
        frame.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4),
        to,
      );
    }
  });
  return { width, height, data };
}

/**
 * Composite equal-sized layers bottom-first with source-over alpha, the way the
 * generator stacks body, clothes, head and hair.
 */
export function stack(layers: readonly Raster[]): Raster {
  if (layers.length === 0) throw new Error("no layers to stack");
  const width = layers[0].width;
  const height = layers[0].height;
  for (const layer of layers) {
    if (layer.width !== width || layer.height !== height) {
      throw new Error(
        `layer sizes differ (${layer.width}x${layer.height} vs ${width}x${height}); ` +
          "all layers must share one grid",
      );
    }
  }
  if (layers.length === 1) return layers[0];

  const data = new Uint8Array(width * height * 4);
  for (const layer of layers) {
    const src = layer.data;
    for (let p = 0; p < src.length; p += 4) {
      const sa = src[p + 3];
      if (sa === 0) continue;
      if (sa === 255) {
        data[p] = src[p];
        data[p + 1] = src[p + 1];
        data[p + 2] = src[p + 2];
        data[p + 3] = 255;
        continue;
      }
      const alpha = sa / 255;
      const dstA = data[p + 3] / 255;
      const outA = alpha + dstA * (1 - alpha);
      if (outA === 0) continue;
      data[p] = Math.round(
        (src[p] * alpha + data[p] * dstA * (1 - alpha)) / outA,
      );
      data[p + 1] = Math.round(
        (src[p + 1] * alpha + data[p + 1] * dstA * (1 - alpha)) / outA,
      );
      data[p + 2] = Math.round(
        (src[p + 2] * alpha + data[p + 2] * dstA * (1 - alpha)) / outA,
      );
      data[p + 3] = Math.round(outA * 255);
    }
  }
  return { width, height, data };
}

/** `#rrggbb` to channels. */
export function parseHex(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Union box of every non-transparent pixel across same-sized frames, so the
 * whole animation stays registered when it is cropped.
 */
export function unionBounds(frames: readonly Raster[]): Bounds | null {
  if (frames.length === 0) throw new Error("no frames to measure");
  const { width, height } = frames[0];
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error("--trim needs uniformly sized frames");
    }
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const frame of frames) {
    const data = frame.data;
    for (let p = 3; p < data.length; p += 4) {
      if (data[p] === 0) continue;
      const i = p >> 2;
      const x = i % width;
      const y = (i - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Center a smaller raster on a larger transparent canvas. */
export function padTo(source: Raster, width: number, height: number): Raster {
  if (width === source.width && height === source.height) return source;
  if (width < source.width || height < source.height) {
    throw new Error(
      `canvas ${width}x${height} is smaller than the frame ${source.width}x${source.height}`,
    );
  }
  const data = new Uint8Array(width * height * 4);
  const x0 = Math.floor((width - source.width) / 2);
  const y0 = Math.floor((height - source.height) / 2);
  for (let y = 0; y < source.height; y++) {
    const from = y * source.width * 4;
    data.set(
      source.data.subarray(from, from + source.width * 4),
      (y0 + y) * width * 4 + x0 * 4,
    );
  }
  return { width, height, data };
}

/**
 * Reduce pixel art to a solid silhouette, the classic stickman look. Pixels
 * below alpha 128 count as background; `outline` paints a 1px ring in the
 * empty pixels directly touching the figure.
 */
export function silhouette(
  source: Raster,
  ink: Rgb,
  outline: Rgb | null,
): Raster {
  const { width, height, data } = source;
  const opaque = new Uint8Array(width * height);
  for (let i = 0; i < opaque.length; i++) {
    if (data[i * 4 + 3] >= 128) opaque[i] = 1;
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let rgb: Rgb | null = null;
      if (opaque[i] === 1) {
        rgb = ink;
      } else if (outline !== null) {
        const touching =
          (x > 0 && opaque[i - 1] === 1) ||
          (x < width - 1 && opaque[i + 1] === 1) ||
          (y > 0 && opaque[i - width] === 1) ||
          (y < height - 1 && opaque[i + width] === 1);
        if (touching) rgb = outline;
      }
      if (rgb === null) continue;
      const o = i * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
