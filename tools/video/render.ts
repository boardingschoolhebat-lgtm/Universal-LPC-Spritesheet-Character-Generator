// Shared render pipeline: ordered frames in, GIF/MP4/WebM/PNG sequence out.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

import { encodeGif } from "./gif.ts";
import {
  crop,
  flatten,
  padTo,
  parseHex,
  scaleNearest,
  silhouette,
  unionBounds,
  type Rgb,
} from "./image.ts";
import { encodePng, type Raster } from "./png.ts";

export type LoopMode = "forward" | "pingpong";
export type VideoFormat = "gif" | "mp4" | "webm";
export type StyleMode = "normal" | "silhouette";

export type RenderRequest = {
  outPath: string;
  fps: number;
  scale: number;
  loop: LoopMode;
  hold: number;
  duration: number | null;
  /** `#rrggbb`, or `null` to keep transparency where the format allows it. */
  bg: string | null;
  framesDir: string | null;
  /** Reduce the figure to a solid silhouette before scaling. */
  style?: StyleMode | null;
  /** Silhouette ink `#rrggbb` (default near-black) plus optional 1px outline. */
  ink?: string | null;
  outline?: string | null;
  /** Crop all frames to their union ink box before scaling. */
  trim?: boolean | null;
  /** Center the output on a `<w>:<h>` canvas (contain), e.g. `9:16`. */
  fit?: string | null;
};

export type RenderResult = {
  path: string;
  format: VideoFormat;
  frames: number;
  width: number;
  height: number;
  transparent: boolean;
};

export const FORMATS: readonly VideoFormat[] = ["gif", "mp4", "webm"];

export function formatOf(path: string): VideoFormat {
  const extension = extname(path).toLowerCase().slice(1);
  if (!FORMATS.includes(extension as VideoFormat)) {
    throw new Error("--out must end in .gif, .mp4, or .webm");
  }
  return extension as VideoFormat;
}

/** Apply loop mode, frame holds and duration padding to a frame list. */
export function resolveSequence(
  frames: readonly Raster[],
  options: Pick<RenderRequest, "hold" | "loop" | "duration" | "fps">,
): Raster[] {
  let list = [...frames];
  if (options.hold > 1) {
    list = list.flatMap((frame) =>
      Array.from({ length: options.hold }, () => frame),
    );
  }
  if (options.loop === "pingpong" && list.length > 2) {
    list = [...list, ...list.slice(1, -1).reverse()];
  }
  if (options.duration !== null) {
    const total = Math.max(1, Math.round(options.duration * options.fps));
    list = Array.from(
      { length: total },
      (_, index) => list[index % list.length],
    );
  }
  return list;
}

export function writeFrames(
  directory: string,
  frames: readonly Raster[],
): void {
  mkdirSync(directory, { recursive: true });
  frames.forEach((frame, index) => {
    const name = `frame-${String(index + 1).padStart(4, "0")}.png`;
    writeFileSync(join(directory, name), encodePng(frame));
  });
}

/** Honour `FFMPEG`, otherwise whatever is on `PATH`. */
export function findFfmpeg(): string | null {
  const candidate = process.env.FFMPEG ?? "ffmpeg";
  const probe = spawnSync(candidate, ["-version"], { stdio: "ignore" });
  return probe.status === 0 ? candidate : null;
}

const MISSING_FFMPEG =
  "ffmpeg not found. Install ffmpeg, or use --frames <dir> and encode yourself:\n" +
  "  ffmpeg -framerate 8 -i frame-%04d.png -c:v libx264 -pix_fmt yuv420p video.mp4";

function encodeVideo(
  ffmpeg: string,
  outPath: string,
  format: VideoFormat,
  fps: number,
  withAlpha: boolean,
): void {
  const input = ["-y", "-framerate", String(fps), "-i", "frame-%04d.png"];

  const args =
    format === "webm"
      ? [
          ...input,
          "-c:v",
          "libvpx-vp9",
          "-pix_fmt",
          withAlpha ? "yuva420p" : "yuv420p",
          "-b:v",
          "0",
          "-crf",
          "24",
          outPath,
        ]
      : [
          ...input,
          // H.264 needs even dimensions; pad instead of cropping the art.
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
          "-c:v",
          "libx264",
          "-preset",
          "slow",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          outPath,
        ];

  const result = spawnSync(ffmpeg, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) {
    const detail =
      result.stderr?.toString().trim().split("\n").slice(-3).join("\n") ?? "";
    throw new Error(
      `ffmpeg failed to write ${basename(outPath)}${detail === "" ? "" : `:\n${detail}`}`,
    );
  }
}

const FIT_PATTERN = /^([1-9]\d*):([1-9]\d*)$/;

/** Aspect target as a simple w/h scalar; see `styleAndSize`. */
function ratioOf(fit: string): number {
  const match = FIT_PATTERN.exec(fit);
  if (match === null)
    throw new Error('--fit must be <width>:<height>, e.g. "9:16" or "1:1"');
  return Number(match[1]) / Number(match[2]);
}

/**
 * Visual pipeline shared by all CLIs: optional stickman style, union trim,
 * nearest-neighbour upscale, and contain-padding into a target ratio.
 * Frame sizes stay identical across the whole list.
 */
export function styleAndSize(
  frames: readonly Raster[],
  options: {
    style: StyleMode;
    ink: Rgb;
    outline: Rgb | null;
    trim: boolean;
    fit: string | null;
    scale: number;
  },
): Raster[] {
  let list = [...frames];
  if (options.style === "silhouette") {
    list = list.map((frame) => silhouette(frame, options.ink, options.outline));
  }
  if (options.trim) {
    const bounds = unionBounds(list);
    if (bounds !== null) {
      list = list.map((frame) =>
        crop(frame, bounds.x, bounds.y, bounds.width, bounds.height),
      );
    }
  }
  list = list.map((frame) => scaleNearest(frame, options.scale));
  if (options.fit !== null) {
    const ratio = ratioOf(options.fit);
    const first = list[0];
    let width = first.width;
    let height = first.height;
    if (width / height < ratio)
      width = Math.max(width, Math.round(height * ratio));
    else height = Math.max(height, Math.round(width / ratio));
    list = list.map((frame) => padTo(frame, width, height));
  }
  return list;
}

/**
 * Scale, loop, and encode a frame list. Returns what was written so callers can
 * print a summary.
 */
export function renderFrames(
  frames: readonly Raster[],
  request: RenderRequest,
): RenderResult {
  if (frames.length === 0) throw new Error("no frames to assemble");

  const outPath = request.outPath;
  const format = formatOf(outPath);

  // MP4 has no usable alpha, so it always gets a background; GIF and WebM keep
  // transparency unless --bg asks otherwise.
  const withAlpha = request.bg === null && format !== "mp4";
  const fill: Rgb =
    request.bg !== null ? parseHex(request.bg) : [255, 255, 255];

  const scaled = styleAndSize(resolveSequence(frames, request), {
    style: request.style ?? "normal",
    ink: parseHex(request.ink ?? "#1a1a1a"),
    outline:
      request.outline === undefined ||
      request.outline === null ||
      request.outline === ""
        ? null
        : parseHex(request.outline),
    trim: request.trim === true,
    fit: request.fit ?? null,
    scale: request.scale,
  });
  const sequence = withAlpha
    ? scaled
    : scaled.map((frame) => flatten(frame, fill));

  const width = sequence[0].width;
  const height = sequence[0].height;
  mkdirSync(dirname(outPath), { recursive: true });

  if (request.framesDir !== null) writeFrames(request.framesDir, sequence);

  if (format === "gif") {
    const delayCs = Math.max(2, Math.round(100 / request.fps));
    writeFileSync(
      outPath,
      encodeGif(
        sequence,
        sequence.map(() => delayCs),
      ),
    );
    return {
      path: outPath,
      format,
      frames: sequence.length,
      width,
      height,
      transparent: withAlpha,
    };
  }

  const ffmpeg = findFfmpeg();
  if (ffmpeg === null) throw new Error(MISSING_FFMPEG);

  // ffmpeg reads frame-%04d.png relative to its cwd.
  let workDir = request.framesDir;
  const temporary = workDir === null;
  if (workDir === null) workDir = mkdtempSync(join(tmpdir(), "lpc-video-"));
  writeFrames(workDir, sequence);

  const previousCwd = process.cwd();
  process.chdir(workDir);
  try {
    encodeVideo(ffmpeg, outPath, format, request.fps, withAlpha);
  } finally {
    process.chdir(previousCwd);
    if (temporary) rmSync(workDir, { recursive: true, force: true });
  }

  return {
    path: outPath,
    format,
    frames: sequence.length,
    width,
    height,
    transparent: withAlpha,
  };
}

/** One-line summary shared by both CLIs. */
export function summarize(result: RenderResult): string {
  return (
    `${result.format.toUpperCase().padEnd(4)} ${result.path}\n` +
    `     ${result.frames} frames, ${result.width}x${result.height}, ` +
    `${result.transparent ? "transparent background" : "solid background"}`
  );
}
