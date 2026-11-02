// Slice an LPC spritesheet (or a folder of numbered frames) and assemble it
// into an animated GIF / MP4 / WebM, plus an optional PNG sequence for video
// editors. Pure Node: PNG and GIF are handled in-tree; MP4/WebM need ffmpeg.
//
//   node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png \
//     --direction down --cycle walk --fps 8 --scale 4 --out walk.gif
//
// Raw repo sheets are single layers, so `--layer` stacks more of them (bottom
// first) into one character:
//
//   node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png \
//     --layer spritesheets/legs/pants/male/walk.png \
//     --layer spritesheets/head/heads/human/male/walk.png \
//     --direction down --cycle walk --out character-walk.gif
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { FRAME_SIZE } from "../../sources/state/constants.ts";
import {
  renderFrames,
  summarize,
  type LoopMode,
  type RenderRequest,
  type StyleMode,
} from "./render.ts";
import {
  ANIMATION_CYCLES,
  describeSheet,
  loadPng,
  readFolderFrames,
  sliceSheet,
  sliceStack,
} from "./sheet.ts";

type Options = {
  input: string;
  layers: string[];
  out: string;
  direction: string;
  framesDir: string | null;
  fps: number;
  scale: number;
  loop: LoopMode;
  cycle: string | null;
  row: number | null;
  duration: number | null;
  bg: string | null;
  hold: number;
  trim: boolean;
  fit: string | null;
  style: StyleMode | null;
  ink: string | null;
  outline: string | null;
  list: boolean;
};

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const FIT_PATTERN = /^([1-9]\d*):([1-9]\d*)$/;

const USAGE = `Slice an LPC spritesheet and assemble it into an animation/video.

  node tools/video/lpc-video.ts <input> [options]

<input>  LPC PNG (grid ${FRAME_SIZE}px) or a folder of PNG frames

Layer & cycle options
  --layer <png>      add a layer above <input> (repeatable, bottom → top)
  --out <file>       output .gif | .mp4 | .webm   (default: lpc.gif)
  --direction <d>    up | left | right | down | all  (default: down)
  --cycle <anim>     use the app's official frame cycle (walk, run, slash, ...)
  --row <n>          force a sheet row number (0-3)

Appearance options
  --fps <n>          frames per second           (default: 8)
  --scale <n>        nearest-neighbour upscale   (default: 4)
  --loop <mode>      forward | pingpong          (default: forward)
  --hold <n>         repeat each frame n times   (default: 1)
  --duration <sec>   repeat the cycle until this duration
  --bg <#rrggbb>     solid background (default: transparent)
  --trim             crop the transparent padding around the animation
  --fit <w:h>        center-image onto this ratio, e.g. 9:16 or 1:1
  --style <mode>     normal | silhouette (stickman look)
  --ink <#hex>       silhouette ink              (default: #1a1a1a)
  --outline <#hex>   1px outline around the silhouette
  --frames <dir>     also write a PNG sequence to a folder (for video editors)
  --list             only show sheet info
  --help             show this help`;

function parseArgs(argv: string[]): Options | "help" {
  const options: Options = {
    input: "",
    layers: [],
    out: "lpc.gif",
    direction: "down",
    framesDir: null,
    fps: 8,
    scale: 4,
    loop: "forward",
    cycle: null,
    row: null,
    duration: null,
    bg: null,
    hold: 1,
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
      case "layer":
        options.layers.push(value);
        break;
      case "out":
        options.out = value;
        break;
      case "direction":
        options.direction = value;
        break;
      case "frames":
        options.framesDir = value;
        break;
      case "fps":
        options.fps = Number(value);
        break;
      case "scale":
        options.scale = Number(value);
        break;
      case "loop":
        if (value !== "forward" && value !== "pingpong") {
          throw new Error("--loop must be forward or pingpong");
        }
        options.loop = value;
        break;
      case "cycle":
        options.cycle = value;
        break;
      case "row":
        options.row = Number(value);
        break;
      case "duration":
        options.duration = Number(value);
        break;
      case "bg":
        options.bg = value;
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
    throw new Error("missing <input>: an LPC sheet PNG or a frame folder");
  options.input = positional[0];

  if (!Number.isFinite(options.fps) || options.fps <= 0)
    throw new Error("--fps must be a number > 0");
  if (!Number.isInteger(options.scale) || options.scale < 1) {
    throw new Error("--scale must be an integer >= 1");
  }
  if (!Number.isInteger(options.hold) || options.hold < 1) {
    throw new Error("--hold must be an integer >= 1");
  }
  if (
    options.row !== null &&
    (!Number.isInteger(options.row) || options.row < 0)
  ) {
    throw new Error("--row must be an integer >= 0");
  }
  if (
    options.duration !== null &&
    (!Number.isFinite(options.duration) || options.duration <= 0)
  ) {
    throw new Error("--duration must be a number > 0");
  }
  for (const [name, value] of [
    ["--bg", options.bg],
    ["--ink", options.ink],
    ["--outline", options.outline],
  ] as const) {
    if (value !== null && HEX_PATTERN.test(value) === false) {
      throw new Error(`${name} must be a #rrggbb colour`);
    }
  }

  return options;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsed;

  const inputPath = resolve(options.input);
  const isDirectory = statSync(inputPath).isDirectory();
  if (isDirectory && options.layers.length > 0) {
    throw new Error(
      "--layer only works with a PNG sheet input, not a frame folder",
    );
  }

  if (options.list) {
    if (isDirectory) {
      process.stdout.write(
        `${readFolderFrames(inputPath).length} frame PNG di ${inputPath}\n`,
      );
    } else {
      process.stdout.write(`${describeSheet(loadPng(inputPath))}\n`);
      if (
        options.cycle !== null &&
        ANIMATION_CYCLES[options.cycle] === undefined
      ) {
        process.stdout.write("unknown cycle; using all columns\n");
      }
    }
    return;
  }

  const sliceOptions = {
    direction: options.direction,
    cycle: options.cycle,
    row: options.row,
  };
  const frames = isDirectory
    ? readFolderFrames(inputPath)
    : options.layers.length === 0
      ? sliceSheet(loadPng(inputPath), sliceOptions)
      : sliceStack(
          [inputPath, ...options.layers].map((path) => loadPng(resolve(path))),
          sliceOptions,
        );

  const request: RenderRequest = {
    outPath: resolve(options.out),
    fps: options.fps,
    scale: options.scale,
    loop: options.loop,
    hold: options.hold,
    duration: options.duration,
    bg: options.bg,
    framesDir: options.framesDir === null ? null : resolve(options.framesDir),
    trim: options.trim,
    fit: options.fit,
    style: options.style,
    ink: options.ink,
    outline: options.outline,
  };
  const result = renderFrames(frames, request);
  if (request.framesDir !== null) {
    process.stdout.write(`PNG  ${request.framesDir}/frame-0001.png ...\n`);
  }
  process.stdout.write(`${summarize(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exit(1);
}
