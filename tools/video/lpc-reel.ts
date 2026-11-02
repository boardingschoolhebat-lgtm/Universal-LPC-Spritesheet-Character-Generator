// Concatenate several LPC clips into one video: the "reel" that batch renders
// separately for. Each clip reuses the same slicing as lpc-video (sheet path,
// optional layers, direction, cycle, duration), then the frame lists are
// concatenated with a gap between clips and encoded once, so sizes, fps and
// styling line up everywhere.
//
//   node tools/video/lpc-reel.ts plan.json --out reel.mp4 --bg '#101010'
//
// Manifest (paths relative to the manifest file itself):
// {
//   "fps": 12, "scale": 4, "loop": "forward", "hold": 1, "bg": "#101010",
//   "gap": 4, "gapMode": "freeze", "trim": false, "fit": null,
//   "style": "normal", "ink": "#1a1a1a", "outline": null,
//   "clips": [
//     { "sheet": "walk.png", "layers": ["pants/c1/walk.png"],
//       "direction": "down", "cycle": "walk", "duration": 2 }
//   ]
// }
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  renderFrames,
  summarize,
  type LoopMode,
  type RenderRequest,
  type StyleMode,
} from "./render.ts";
import { cycleForFile, loadPng, sliceSheet, sliceStack } from "./sheet.ts";
import type { Raster } from "./png.ts";

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const FIT_PATTERN = /^([1-9]\d*):([1-9]\d*)$/;
const DIRECTION_PATTERN = /^(up|left|right|down|all)$/;

type ManifestClip = {
  sheet: string;
  layers?: string[];
  direction?: string;
  cycle?: string | null;
  duration?: number;
  hold?: number;
  loop?: string;
};

type Manifest = {
  fps?: number;
  scale?: number;
  loop?: string;
  hold?: number;
  bg?: string | null;
  direction?: string;
  gap?: number;
  gapMode?: string;
  trim?: boolean;
  fit?: string | null;
  style?: string;
  ink?: string | null;
  outline?: string | null;
  clips: ManifestClip[];
};

type Options = {
  planPath: string;
  out: string;
  fps: number | null;
  scale: number | null;
  bg: string | null;
  gap: number | null;
  gapMode: "freeze" | "blank" | null;
  loop: LoopMode | null;
  hold: number | null;
  trim: boolean;
  fit: string | null;
  style: StyleMode | null;
  ink: string | null;
  outline: string | null;
  list: boolean;
};

const USAGE = `Concatenate several LPC clips into one video (a "reel").

  node tools/video/lpc-reel.ts plan.json [options]

plan.json  a manifest listing the clips (see the format below)

The CLI options override the same values in the manifest
  --out <file>       output .gif | .mp4 | .webm   (default: reel.gif)
  --fps <n>          frames per second            (default: 8)
  --scale <n>        nearest-neighbour upscale    (default: 4)
  --bg <#rrggbb>     solid background (default: transparent, except mp4)
  --gap <n>          frames of space between clips (default: 0)
  --gap-mode <mode>  freeze (repeat the last frame) | blank (empty frame)
  --loop <mode>      forward | pingpong per clip  (default: forward)
  --hold <n>         repeat each frame n times    (default: 1)
  --trim             crop to the union of all clips
  --fit <w:h>        center-image onto this ratio, e.g. 9:16 or 1:1
  --style <mode>     normal | silhouette (stickman look)
  --ink <#hex>       silhouette ink               (default: #1a1a1a)
  --outline <#hex>   1px outline around the silhouette
  --list             show the render plan without rendering
  --help             show this help

Bentuk manifest:
  {
    "fps": 12, "scale": 4, "bg": "#101010", "gap": 4, "gapMode": "freeze",
    "direction": "down", "trim": false, "fit": "9:16", "style": "normal",
    "clips": [
      { "sheet": "spritesheets/body/.../walk.png",
        "layers": ["spritesheets/.../walk.png"],
        "cycle": "walk", "duration": 2 }
    ]
  }`;

function parseArgs(argv: string[]): Options | "help" {
  const options: Options = {
    planPath: "",
    out: "reel.gif",
    fps: null,
    scale: null,
    bg: null,
    gap: null,
    gapMode: null,
    loop: null,
    hold: null,
    trim: false,
    fit: null,
    style: null,
    ink: null,
    outline: null,
    list: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(2, equals) : arg.slice(2);
    const value =
      equals >= 0
        ? arg.slice(equals + 1)
        : name === "trim" || name === "list" || name === "help"
          ? "true"
          : (argv[++i] ?? "");

    switch (name) {
      case "trim":
        options.trim = true;
        break;
      case "fit":
        if (FIT_PATTERN.test(value) === false) {
          throw new Error(
            '--fit must be <width>:<height>, e.g. "9:16" or "1:1"',
          );
        }
        options.fit = value;
        break;
      case "style":
        if (value !== "normal" && value !== "silhouette") {
          throw new Error("--style must be normal or silhouette");
        }
        options.style = value;
        break;
      case "ink":
        options.ink = value;
        break;
      case "outline":
        options.outline = value;
        break;
      case "out":
        options.out = value;
        break;
      case "fps":
        options.fps = Number(value);
        break;
      case "scale":
        options.scale = Number(value);
        break;
      case "bg":
        options.bg = value;
        break;
      case "gap":
        options.gap = Number(value);
        break;
      case "gap-mode":
        if (value !== "freeze" && value !== "blank") {
          throw new Error("--gap-mode must be freeze or blank");
        }
        options.gapMode = value;
        break;
      case "loop":
        if (value !== "forward" && value !== "pingpong") {
          throw new Error("--loop must be forward or pingpong");
        }
        options.loop = value;
        break;
      case "hold":
        options.hold = Number(value);
        break;
      case "list":
        options.list = true;
        break;
      case "help":
        return "help";
      default:
        throw new Error(`unknown option: --${name}`);
    }
  }

  if (positional.length === 0)
    throw new Error("missing <plan.json> listing the clips");
  options.planPath = positional[0];

  if (
    options.fps !== null &&
    (!Number.isFinite(options.fps) || options.fps <= 0)
  ) {
    throw new Error("--fps must be a number > 0");
  }
  if (
    options.scale !== null &&
    (!Number.isInteger(options.scale) || options.scale < 1)
  ) {
    throw new Error("--scale must be an integer >= 1");
  }
  if (
    options.hold !== null &&
    (!Number.isInteger(options.hold) || options.hold < 1)
  ) {
    throw new Error("--hold must be an integer >= 1");
  }
  if (
    options.gap !== null &&
    (!Number.isInteger(options.gap) || options.gap < 0)
  ) {
    throw new Error("--gap must be an integer >= 0");
  }
  return options;
}

function validateHex(name: string, value: string | null | undefined): void {
  if (value != null && value !== "" && HEX_PATTERN.test(value) === false) {
    throw new Error(`${name} must be a #rrggbb colour`);
  }
}

function positiveNumber(name: string, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a number > 0`);
  }
  return value;
}

function directionOf(value: unknown): string {
  if (value === undefined) return "down";
  if (typeof value !== "string" || DIRECTION_PATTERN.test(value) === false) {
    throw new Error("direction must be up, left, right, down, or all");
  }
  return value;
}

type ClipPlan = {
  label: string;
  direction: string;
  cycle: string | null;
  frames: number;
  seconds: number;
};

/**
 * Turn the manifest into one long raw frame list. CLI values win over manifest
 * values, manifest values over defaults. Frames are still 64px cells here;
 * styling, trimming and scaling are renderFrames' job.
 */
function buildSequence(
  manifest: Manifest,
  options: {
    fps: number;
    hold: number;
    loop: LoopMode;
    gap: number;
    gapMode: "freeze" | "blank";
    direction: string;
    planDirectory: string;
  },
): { frames: Raster[]; plan: ClipPlan[] } {
  if (!Array.isArray(manifest.clips) || manifest.clips.length === 0) {
    throw new Error("the manifest needs a clips array with at least one clip");
  }

  const frames: Raster[] = [];
  const plan: ClipPlan[] = [];

  manifest.clips.forEach((clip, index) => {
    if (typeof clip.sheet !== "string" || clip.sheet === "") {
      throw new Error(`clips[${index}].sheet must be a PNG path`);
    }
    if (clip.layers !== undefined && !Array.isArray(clip.layers)) {
      throw new Error(`clips[${index}].layers must be an array of PNG paths`);
    }
    if (
      clip.hold !== undefined &&
      (!Number.isInteger(clip.hold) || clip.hold < 1)
    ) {
      throw new Error(`clips[${index}].hold must be an integer >= 1`);
    }
    if (
      clip.loop !== undefined &&
      clip.loop !== "forward" &&
      clip.loop !== "pingpong"
    ) {
      throw new Error(`clips[${index}].loop must be forward or pingpong`);
    }

    const direction =
      clip.direction === undefined
        ? options.direction
        : directionOf(clip.direction);
    const cycle =
      clip.cycle === undefined
        ? cycleForFile(clip.sheet.split("/").pop() ?? "")
        : typeof clip.cycle === "string"
          ? clip.cycle
          : null;
    const duration = positiveNumber(`clips[${index}].duration`, clip.duration);

    const paths = [clip.sheet, ...(clip.layers ?? [])].map((path) =>
      join(options.planDirectory, path),
    );
    const sliceOptions = { direction, cycle, row: null };
    const raw =
      paths.length === 1
        ? sliceSheet(loadPng(paths[0]), sliceOptions)
        : sliceStack(
            paths.map((path) => loadPng(path)),
            sliceOptions,
          );

    const held = raw.flatMap((frame) =>
      Array.from({ length: clip.hold ?? options.hold }, () => frame),
    );
    const loopMode = (clip.loop ?? options.loop) as LoopMode;
    const looped =
      loopMode === "pingpong" && held.length > 2
        ? [...held, ...held.slice(1, -1).reverse()]
        : held;
    const finalFrames =
      duration === null
        ? looped
        : Array.from(
            { length: Math.max(1, Math.round(duration * options.fps)) },
            (_, i) => looped[i % looped.length],
          );

    frames.push(...finalFrames);
    if (index < manifest.clips.length - 1 && options.gap > 0) {
      if (options.gapMode === "freeze") {
        frames.push(
          ...Array.from({ length: options.gap }, () => finalFrames.at(-1)!),
        );
      } else {
        const last = finalFrames.at(-1)!;
        frames.push(
          ...Array.from({ length: options.gap }, () => ({
            width: last.width,
            height: last.height,
            data: new Uint8Array(last.width * last.height * 4),
          })),
        );
      }
    }

    plan.push({
      label: `#${index + 1} ${clip.sheet.split("/").pop()}`,
      direction,
      cycle,
      frames: finalFrames.length,
      seconds: finalFrames.length / options.fps,
    });
  });

  return { frames, plan };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsed;

  const planPath = resolve(options.planPath);
  const manifest = JSON.parse(
    new TextDecoder().decode(readFileSync(planPath)),
  ) as Manifest;
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("the manifest must be a JSON object");
  }

  validateHex("--bg", options.bg ?? manifest.bg);
  validateHex("--ink", options.ink ?? manifest.ink);
  validateHex("--outline", options.outline ?? manifest.outline);
  if (options.fit === null && manifest.fit != null) {
    if (
      typeof manifest.fit !== "string" ||
      FIT_PATTERN.test(manifest.fit) === false
    ) {
      throw new Error('fit must be <width>:<height>, e.g. "9:16"');
    }
  }
  const styleValue = options.style ?? manifest.style ?? "normal";
  if (styleValue !== "normal" && styleValue !== "silhouette") {
    throw new Error("--style must be normal or silhouette");
  }
  const gapModeValue = (options.gapMode ?? manifest.gapMode ?? "freeze") as
    "freeze" | "blank";
  if (gapModeValue !== "freeze" && gapModeValue !== "blank") {
    throw new Error("--gap-mode must be freeze or blank");
  }

  const fps = options.fps ?? manifest.fps ?? 8;
  if (!Number.isInteger(fps) || fps <= 0)
    throw new Error("fps must be an integer > 0");
  const scale = options.scale ?? manifest.scale ?? 4;
  if (!Number.isInteger(scale) || scale < 1)
    throw new Error("scale must be an integer >= 1");
  const gap = options.gap ?? manifest.gap ?? 0;
  if (!Number.isInteger(gap) || gap < 0)
    throw new Error("gap must be an integer >= 0");

  const mergedOptions = {
    fps,
    hold: manifest.hold ?? 1,
    loop: options.loop ?? (manifest.loop as LoopMode | undefined) ?? "forward",
    gap,
    gapMode: gapModeValue,
    direction: directionOf(manifest.direction),
    planDirectory: dirname(planPath),
  };
  const { frames, plan } = buildSequence(manifest, mergedOptions);

  if (options.list) {
    process.stdout.write(
      `${fps} fps, gap ${gap} ${gapModeValue}, ${plan.length} clips\n`,
    );
    for (const entry of plan) {
      const cycle = entry.cycle ?? "all columns";
      process.stdout.write(
        `  ${entry.label.padEnd(22)} ${entry.direction.padEnd(5)} ${cycle.padEnd(10)} ` +
          `${entry.frames} frames (${entry.seconds.toFixed(2)}s)\n`,
      );
    }
    const total = frames.length / fps;
    process.stdout.write(
      `total ${frames.length} frames (~${total.toFixed(2)} seconds), scale x${scale}\n`,
    );
    return;
  }

  const request: RenderRequest = {
    outPath: resolve(options.out),
    fps,
    scale,
    // Loop/hold/duration were applied per clip above, so hand renderFrames a
    // finished sequence.
    loop: "forward",
    hold: 1,
    duration: null,
    bg: options.bg ?? manifest.bg ?? null,
    framesDir: null,
    trim: options.trim || manifest.trim === true,
    fit: options.fit ?? manifest.fit ?? null,
    style: styleValue as StyleMode,
    ink: options.ink ?? manifest.ink ?? null,
    outline: options.outline ?? manifest.outline ?? null,
  };
  const result = renderFrames(frames, request);
  process.stdout.write(
    `${summarize(result)}\nduration ~${(result.frames / fps).toFixed(2)} seconds\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exit(1);
}
