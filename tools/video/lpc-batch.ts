// Render every animation sheet in a folder in one run: one clip per animation,
// using that animation's own frame cycle.
//
//   node tools/video/lpc-batch.ts tmp/pack --out tmp/clips --format mp4 --bg '#101010'
//
// Raw repo sheets are single layers per animation folder, so `--layer` can add
// the same layer set to every clip; `{name}` is replaced by the animation name.
//
//   node tools/video/lpc-batch.ts spritesheets/body/bodies/male \
//     --layer 'spritesheets/legs/pants/male/{name}.png' --out tmp/clips
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import {
  renderFrames,
  summarize,
  type LoopMode,
  type StyleMode,
  type VideoFormat,
} from "./render.ts";
import {
  cycleForFile,
  describeSheet,
  isSheet,
  loadPng,
  sliceSheet,
  sliceStack,
} from "./sheet.ts";

type Options = {
  inputDir: string;
  outDir: string;
  layers: string[];
  format: VideoFormat;
  direction: string;
  fps: number;
  scale: number;
  loop: LoopMode;
  hold: number;
  duration: number | null;
  bg: string | null;
  trim: boolean;
  fit: string | null;
  style: StyleMode | null;
  ink: string | null;
  outline: string | null;
  list: boolean;
};

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const FIT_PATTERN = /^([1-9]\d*):([1-9]\d*)$/;

const USAGE = `Render every animation in one folder in a single run.

  node tools/video/lpc-batch.ts <folder> [options]

<folder>  a folder of per-animation PNG sheets (walk.png, run.png, ...)

Options
  --layer <png>      extra layer for each animation, repeatable;
                     {name} becomes the animation name, e.g. 'hair/{name}.png'
  --out <dir>        output folder                (default: lpc-clips)
  --format <fmt>     gif | mp4 | webm             (default: gif)
  --direction <d>    up | left | right | down | all (default: down)
  --fps <n>          frames per second            (default: 8)
  --scale <n>        nearest-neighbour upscale    (default: 4)
  --loop <mode>      forward | pingpong           (default: forward)
  --hold <n>         repeat each frame n times    (default: 1)
  --duration <sec>   repeat the cycle until this duration
  --bg <#rrggbb>     solid background (default: transparent, except mp4)
  --trim             crop the transparent padding around each clip
  --fit <w:h>        center-image onto this ratio, e.g. 9:16 or 1:1
  --style <mode>     normal | silhouette (stickman look)
  --ink <#hex>       silhouette ink               (default: #1a1a1a)
  --outline <#hex>   1px outline around the silhouette
  --list             show the folder contents without rendering
  --help             show this help`;

function parseArgs(argv: string[]): Options | "help" {
  const options: Options = {
    inputDir: "",
    outDir: "lpc-clips",
    layers: [],
    format: "gif",
    direction: "down",
    fps: 8,
    scale: 4,
    loop: "forward",
    hold: 1,
    duration: null,
    bg: null,
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
        options.outDir = value;
        break;
      case "format":
        if (value !== "gif" && value !== "mp4" && value !== "webm") {
          throw new Error("--format must be gif, mp4, or webm");
        }
        options.format = value;
        break;
      case "direction":
        options.direction = value;
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
      case "hold":
        options.hold = Number(value);
        break;
      case "duration":
        options.duration = Number(value);
        break;
      case "bg":
        options.bg = value;
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
    throw new Error("missing <folder> of PNG sheets");
  options.inputDir = positional[0];

  if (!Number.isFinite(options.fps) || options.fps <= 0)
    throw new Error("--fps must be a number > 0");
  if (!Number.isInteger(options.scale) || options.scale < 1) {
    throw new Error("--scale must be an integer >= 1");
  }
  if (!Number.isInteger(options.hold) || options.hold < 1) {
    throw new Error("--hold must be an integer >= 1");
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

type Entry = { name: string; path: string; cycle: string | null };

function discover(directory: string): Entry[] {
  const files = readdirSync(directory)
    .filter((name) => extname(name).toLowerCase() === ".png")
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) throw new Error(`no PNG files in ${directory}`);

  const entries: Entry[] = [];
  for (const name of files) {
    const path = join(directory, name);
    const sheet = loadPng(path);
    if (!isSheet(sheet)) {
      process.stderr.write(
        `skipping ${name}: not a 64px grid (${sheet.width}x${sheet.height})\n`,
      );
      continue;
    }
    entries.push({
      name: basename(name, extname(name)),
      path,
      cycle: cycleForFile(name),
    });
  }
  if (entries.length === 0) throw new Error(`no LPC sheets in ${directory}`);
  return entries;
}

/** Layer templates for one animation; templates naming a missing sheet are skipped. */
function layersFor(templates: readonly string[], animation: string): string[] {
  return templates
    .map((template) => template.replaceAll("{name}", animation))
    .filter((path) => existsSync(resolve(path)));
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsed;

  const inputDir = resolve(options.inputDir);
  const entries = discover(inputDir);

  if (options.list) {
    const known = entries.filter((entry) => entry.cycle !== null).length;
    process.stdout.write(
      `${entries.length} sheets in ${inputDir} (${known} with an official cycle)\n`,
    );
    for (const entry of entries) {
      const cells = describeSheet(loadPng(entry.path)).split("\n")[1];
      const cycle = entry.cycle ?? "all columns (not in ANIMATION_CONFIGS)";
      process.stdout.write(`  ${entry.name.padEnd(12)} ${cells} — ${cycle}\n`);
    }
    return;
  }

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  let ok = 0;
  const failed: string[] = [];
  for (const entry of entries) {
    try {
      const sliceOptions = {
        direction: options.direction,
        cycle: entry.cycle,
        row: null,
      };
      const extra = layersFor(options.layers, entry.name);
      const frames =
        extra.length === 0
          ? sliceSheet(loadPng(entry.path), sliceOptions)
          : sliceStack(
              [entry.path, ...extra].map((path) => loadPng(resolve(path))),
              sliceOptions,
            );
      const result = renderFrames(frames, {
        outPath: join(
          outDir,
          `${entry.name}-${options.direction}.${options.format}`,
        ),
        fps: options.fps,
        scale: options.scale,
        loop: options.loop,
        hold: options.hold,
        duration: options.duration,
        bg: options.bg,
        framesDir: null,
        trim: options.trim,
        fit: options.fit,
        style: options.style,
        ink: options.ink,
        outline: options.outline,
      });
      ok += 1;
      process.stdout.write(`${summarize(result)}\n`);
    } catch (error) {
      failed.push(entry.name);
      process.stderr.write(
        `failed ${entry.name}: ${(error as Error).message}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${ok}/${entries.length} clips written to ${outDir}\n`,
  );
  if (failed.length > 0) {
    process.stderr.write(`failed: ${failed.join(", ")}\n`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exit(1);
}
