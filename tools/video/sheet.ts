// LPC spritesheet slicing: turn a PNG grid (or a folder of numbered frames)
// into an ordered list of 64×64 frames, using the app's own animation cycles so
// loops match what the generator previews.
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import {
  ANIMATION_CONFIGS,
  DIRECTIONS,
  FRAME_SIZE,
} from "../../sources/state/constants.ts";
import { composeGrid, crop, stack } from "./image.ts";
import { decodePng, type Raster } from "./png.ts";

export type AnimationCycle = { row: number; num: number; cycle: number[] };

/** `ANIMATION_CONFIGS` with the shape the sheet slicer needs. */
export const ANIMATION_CYCLES = ANIMATION_CONFIGS as unknown as Record<
  string,
  AnimationCycle
>;

export type SliceOptions = {
  /** `up`, `left`, `down`, `right`, or `all` for a 2x2 grid per frame. */
  direction: string;
  /** Name in `ANIMATION_CONFIGS`; `null` plays every column. */
  cycle: string | null;
  /** Force a sheet row instead of deriving it from `direction`. */
  row: number | null;
};

export function loadPng(path: string): Raster {
  return decodePng(new Uint8Array(readFileSync(path)));
}

/** True when the image is a whole number of 64×64 cells. */
export function isSheet(raster: Raster): boolean {
  return raster.width % FRAME_SIZE === 0 && raster.height % FRAME_SIZE === 0;
}

export function sheetColumns(raster: Raster): number {
  return raster.width / FRAME_SIZE;
}

export function sheetRows(raster: Raster): number {
  return raster.height / FRAME_SIZE;
}

/** Column indices for a cycle, clamped to the sheet width. */
export function cycleColumns(columns: number, cycle: string | null): number[] {
  const all = Array.from({ length: columns }, (_, index) => index);
  if (cycle === null) return all;
  const config = ANIMATION_CYCLES[cycle];
  if (config === undefined) {
    throw new Error(
      `unknown --cycle "${cycle}". Options: ${Object.keys(ANIMATION_CYCLES).join(", ")}`,
    );
  }
  const usable = config.cycle.filter((index) => index < columns);
  if (usable.length === 0)
    throw new Error(`cycle "${cycle}" does not fit a ${columns}-column sheet`);
  return usable;
}

function framesForRow(
  sheet: Raster,
  row: number,
  order: readonly number[],
): Raster[] {
  return order.map((column) =>
    crop(sheet, column * FRAME_SIZE, row * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE),
  );
}

function rowIndexFor(
  direction: string,
  rows: number,
  override: number | null,
): number {
  if (override !== null) {
    if (override >= rows)
      throw new Error(`row ${override} is outside the sheet (${rows} rows)`);
    return override;
  }
  return rows === 1 ? 0 : DIRECTIONS.indexOf(direction);
}

/** Cut one sheet into frames for the requested direction and cycle. */
export function sliceSheet(sheet: Raster, options: SliceOptions): Raster[] {
  if (!isSheet(sheet)) {
    throw new Error(
      `size ${sheet.width}x${sheet.height} is not a multiple of ${FRAME_SIZE}; ` +
        "this is not a standard LPC sheet",
    );
  }
  const columns = sheetColumns(sheet);
  const rows = sheetRows(sheet);
  const order = cycleColumns(columns, options.cycle);

  if (options.direction === "all") {
    if (rows < DIRECTIONS.length) {
      throw new Error(
        `--direction all needs ${DIRECTIONS.length} direction rows, but this sheet has ${rows}`,
      );
    }
    const perRow = DIRECTIONS.map((_, row) => framesForRow(sheet, row, order));
    const count = Math.min(...perRow.map((frames) => frames.length));
    return Array.from({ length: count }, (_, index) =>
      composeGrid(
        perRow.map((frames) => frames[index]),
        2,
      ),
    );
  }

  const rowIndex = rowIndexFor(options.direction, rows, options.row);
  if (rowIndex < 0) {
    throw new Error(
      `--direction must be one of ${DIRECTIONS.join(", ")}, or all`,
    );
  }
  return framesForRow(sheet, rowIndex, order);
}

/** Cut the same cells out of several sheets and stack them, bottom first. */
export function sliceStack(
  sheets: readonly Raster[],
  options: SliceOptions,
): Raster[] {
  const perSheet = sheets.map((sheet) => sliceSheet(sheet, options));
  const count = Math.min(...perSheet.map((frames) => frames.length));
  return Array.from({ length: count }, (_, index) =>
    stack(perSheet.map((frames) => frames[index])),
  );
}

/** Read every PNG in a folder as one frame, in natural filename order. */
export function readFolderFrames(directory: string): Raster[] {
  const files = readdirSync(directory)
    .filter((name) => extname(name).toLowerCase() === ".png")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (files.length === 0) throw new Error(`no PNG files in ${directory}`);
  return files.map((name) => loadPng(join(directory, name)));
}

/** Human-readable sheet summary, used by `--list`. */
export function describeSheet(sheet: Raster): string {
  const columns = sheetColumns(sheet);
  const rows = sheetRows(sheet);
  const usableCycles = Object.entries(ANIMATION_CYCLES)
    .filter(([, config]) => Math.max(...config.cycle) < columns)
    .map(([name]) => name);
  const lines = [
    `${sheet.width}x${sheet.height} px`,
    `${columns} columns x ${rows} rows (${FRAME_SIZE}px frames)`,
    `directions per row: ${DIRECTIONS.slice(0, rows).join(", ")}`,
  ];
  if (usableCycles.length > 0)
    lines.push(`matching --cycle values: ${usableCycles.join(", ")}`);
  return lines.join("\n");
}

/**
 * Cycle name for a sheet filename (`walk.png` → `walk`), following the app's
 * folder aliases (`combat_idle`, `backslash`, `halfslash`).
 */
export function cycleForFile(name: string): string | null {
  const base = name.replace(/\.png$/i, "");
  if (ANIMATION_CYCLES[base] !== undefined) return base;
  const aliases: Record<string, string> = {
    combat_idle: "combat",
    backslash: "1h_backslash",
    halfslash: "1h_halfslash",
  };
  return aliases[base] !== undefined && ANIMATION_CYCLES[aliases[base]]
    ? aliases[base]
    : null;
}
