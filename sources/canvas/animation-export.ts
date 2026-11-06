// In-browser animation export: compose frames from the offscreen renderer
// canvas the same way the preview shows them, then encode them as an animated
// GIF — everything client-side, no server or dependency involved.
import { canvas, type DrawCall } from "./renderer.ts";
import { get2DContext, canvasToBlob } from "./canvas-utils.ts";
import { DIRECTIONS } from "../state/constants.ts";
import {
  getPreviewAnimationState,
  directionToRowIndex,
  paintAnimationFrameToContext,
  setPreviewAnimation,
} from "./preview-animation.ts";
import { encodeGif, type GifFrame } from "./gif-encode.ts";
import type { State } from "../state/state.ts";

export type AnimationDirection = "all" | "up" | "left" | "down" | "right";

export type AnimationExportOptions = {
  /** Animation name as shown in the preview (e.g. "walk"). */
  animation: string;
  /** `all` keeps the preview's side-by-side rows; a direction exports one row. */
  direction: AnimationDirection;
  /** Frames per second; GIF delays are rounded to centiseconds. */
  fps: number;
  /** Nearest-neighbour upscale applied after composition (default 2). */
  scale: number;
  /** Export the cycle and its reverse (walks read better; default true). */
  pingpong?: boolean;
  /** CSS colour fill under the frames, or null for transparent (default). */
  background?: string | null;
};

/**
 * Ping-pong expansion (exported for the browser test suite): append the
 * reversed cycle without repeating the first or last frame.
 */
export function expandPingPongFrames(
  frames: number[],
  pingpong?: boolean,
): number[] {
  if (!pingpong || frames.length < 3) {
    return frames.slice();
  }
  return [...frames, ...frames.slice(1, frames.length - 1).reverse()];
}

/** Frame sequence: forward cycle, optionally ping-pong (no duplicate ends). */
function buildCycle(options: AnimationExportOptions): number[] {
  return expandPingPongFrames(
    getPreviewAnimationState().frames.slice(),
    options.pingpong ?? false,
  );
}

function fillBackground(
  ctx: CanvasRenderingContext2D,
  options: AnimationExportOptions,
  frameCanvas: HTMLCanvasElement,
): void {
  if (!options.background) {
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = options.background;
  ctx.fillRect(0, 0, frameCanvas.width, frameCanvas.height);
  ctx.restore();
}

function toFrame(source: HTMLCanvasElement): GifFrame {
  const ctx = get2DContext(source);
  return {
    width: source.width,
    height: source.height,
    data: ctx.getImageData(0, 0, source.width, source.height).data,
  };
}

/**
 * Paint a single-direction frame: draw the full preview strip offscreen once,
 * then copy just the requested row into the scaled frame canvas.
 */
function paintSingleDirectionFrame(
  state: State,
  ctx: CanvasRenderingContext2D,
  options: AnimationExportOptions,
  cycleIndex: number,
  frameSize: number,
): void {
  const preview = getPreviewAnimationState();
  const rowIndex = directionToRowIndex(
    options.direction as "up" | "left" | "down" | "right",
    preview.rowNum,
  );

  const strip = document.createElement("canvas");
  strip.width = frameSize * preview.rowNum;
  strip.height = frameSize;
  const stripCtx = get2DContext(strip);
  paintAnimationFrameToContext(state, stripCtx, cycleIndex);

  ctx.drawImage(
    strip,
    rowIndex * frameSize,
    0,
    frameSize,
    frameSize,
    0,
    0,
    frameSize,
    frameSize,
  );
}

/**
 * Select the animation the caller asked for, refusing names the preview does
 * not know. Without this the preview keeps its previous frames and the export
 * silently ships the wrong animation.
 */
function selectExportAnimation(
  options: Pick<AnimationExportOptions, "animation">,
): void {
  if (setPreviewAnimation(options.animation).length === 0) {
    throw new Error(`unknown animation "${options.animation}"`);
  }
}

/** Compose every cycle frame into raw RGBA bitmaps ready for `encodeGif`. */
function composeFrames(
  state: State,
  options: AnimationExportOptions,
): GifFrame[] {
  const preview = getPreviewAnimationState();
  const frameSize = preview.frameSize;
  const scale = options.scale;
  const single = options.direction !== "all";
  // "all" keeps the preview's side-by-side direction rows in one frame.
  const logicalWidth = single ? frameSize : frameSize * preview.rowNum;

  return buildCycle(options).map((cycleIndex) => {
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = logicalWidth * scale;
    frameCanvas.height = frameSize * scale;
    const ctx = get2DContext(frameCanvas);
    ctx.imageSmoothingEnabled = false; // keep pixel art crisp
    ctx.scale(scale, scale);

    if (single) {
      paintSingleDirectionFrame(state, ctx, options, cycleIndex, frameSize);
    } else {
      paintAnimationFrameToContext(state, ctx, cycleIndex);
    }
    fillBackground(ctx, options, frameCanvas);
    return toFrame(frameCanvas);
  });
}

/**
 * Encode the current character animation as an animated GIF blob.
 * Shares preview state with the animation preview, so the exported frames
 * are exactly what the on-screen preview plays. Callers must have triggered a
 * render first (checked by the model through `window.canvasRenderer`).
 */
export function exportAnimationGif(
  state: State,
  options: AnimationExportOptions,
): Blob {
  if (!canvas) {
    throw new Error("offscreen canvas not ready");
  }
  selectExportAnimation(options);
  const frames = composeFrames(state, options);
  if (frames.length === 0) {
    throw new Error(`no frames found for animation "${options.animation}"`);
  }
  const delayCs = Math.max(2, Math.round(100 / options.fps));
  const bytes = encodeGif(
    frames,
    frames.map(() => delayCs),
  );
  return new Blob([Uint8Array.from(bytes)], { type: "image/gif" });
}

/** Video-codec preference for WebM export; first supported one wins. */
const WEBM_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

/**
 * Whether this browser can record WebM video via MediaRecorder (Chromium and
 * Firefox do; Safari does not). Call before offering the WebM button.
 */
export function isWebmSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    WEBM_MIME_CANDIDATES.some((mime) => MediaRecorder.isTypeSupported(mime))
  );
}

function pickWebmMimeType(): string {
  return (
    WEBM_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) ??
    "video/webm"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record the animation as a WebM blob with MediaRecorder. Frames are composed
 * exactly like the GIF export, then played back in real time from an offscreen
 * canvas captured as a MediaStream — the recording lasts one full cycle
 * (plus the ping-pong return when enabled). Video codecs do not reliably
 * preserve transparency, so prefer a background colour for WebM exports.
 */
export async function exportAnimationWebM(
  state: State,
  options: AnimationExportOptions,
): Promise<Blob> {
  if (!canvas) {
    throw new Error("offscreen canvas not ready");
  }
  if (!isWebmSupported()) {
    throw new Error(
      "MediaRecorder WebM recording is not supported in this browser",
    );
  }
  selectExportAnimation(options);
  const frames = composeFrames(state, options);
  if (frames.length === 0) {
    throw new Error(`no frames found for animation "${options.animation}"`);
  }

  const out = document.createElement("canvas");
  out.width = frames[0].width;
  out.height = frames[0].height;
  const ctx = get2DContext(out);
  const stream = out.captureStream(options.fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: pickWebmMimeType(),
    videoBitsPerSecond: Math.max(2_500_000, Math.round(out.width * 12)),
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const recorded = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();
  const frameMs = 1000 / options.fps;
  for (const frame of frames) {
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(frame.data),
        frame.width,
        frame.height,
      ),
      0,
      0,
    );
    await sleep(frameMs);
  }
  await sleep(frameMs * 2); // tail padding so the last frame is not truncated
  recorder.stop();
  stream.getTracks().forEach((track) => track.stop());
  await recorded;

  return new Blob(chunks, { type: "video/webm" });
}

/**
 * Copy-ready CLI command for `tools/video/lpc-video.ts` rendering the same
 * animation from the spritesheets in `drawCalls`. Layer order follows the draw
 * order (bottom layer first). Custom uploaded layers are noted, since they
 * cannot be referenced by a file path.
 */
export function buildLpcVideoCommand(
  options: Pick<
    AnimationExportOptions,
    "animation" | "direction" | "fps" | "scale"
  >,
  draws: readonly DrawCall[],
): string {
  const layers = draws.filter(
    (draw) =>
      draw.animation === options.animation &&
      draw.source.kind === "catalog" &&
      draw.source.spritePath.endsWith(".png"),
  );
  if (layers.length === 0) {
    return `# no spritesheets found for "${options.animation}" — pick it in the preview, then copy again`;
  }
  const customNote = draws.some(
    (draw) =>
      draw.animation === options.animation && draw.source.kind === "custom",
  )
    ? "# note: a custom-uploaded layer is on this character; add it manually\n"
    : "";
  const [bottom, ...upper] = layers;
  const source =
    bottom.source.kind === "catalog" ? bottom.source.spritePath : "";
  const layerArgs = upper
    .filter((draw) => draw.source.kind === "catalog")
    .map(
      (draw) => `--layer ${(draw.source as { spritePath: string }).spritePath}`,
    );
  const args = [
    "node tools/video/lpc-video.ts",
    source,
    ...layerArgs,
    "--direction",
    options.direction === "all" ? "down" : options.direction,
    "--cycle",
    options.animation,
    "--fps",
    String(options.fps),
    "--scale",
    String(options.scale),
    "--out",
    `${options.animation}.gif`,
  ];
  return `${customNote}${args.join(" ")}`;
}

/**
 * One PNG strip per direction: every cycle frame of that row laid out
 * left-to-right at the requested scale, composed from the same preview
 * painter the GIF/WebM exports use (so custom animations work too).
 */
function composeDirectionStrip(
  state: State,
  direction: Exclude<AnimationDirection, "all">,
  scale: number,
): HTMLCanvasElement {
  const preview = getPreviewAnimationState();
  const frameSize = preview.frameSize;
  const rowIndex = directionToRowIndex(direction, preview.rowNum);

  const strip = document.createElement("canvas");
  strip.width = frameSize * preview.frames.length;
  strip.height = frameSize;
  const stripCtx = get2DContext(strip);

  // The preview painter lays the direction rows side by side, so each cycle
  // frame needs a full-width canvas before the wanted row can be copied out.
  const rowSet = document.createElement("canvas");
  rowSet.width = frameSize * preview.rowNum;
  rowSet.height = frameSize;
  const rowSetCtx = get2DContext(rowSet);

  preview.frames.forEach((cycleIndex, index) => {
    rowSetCtx.clearRect(0, 0, rowSet.width, rowSet.height);
    paintAnimationFrameToContext(state, rowSetCtx, cycleIndex);
    stripCtx.drawImage(
      rowSet,
      rowIndex * frameSize,
      0,
      frameSize,
      frameSize,
      index * frameSize,
      0,
      frameSize,
      frameSize,
    );
  });

  if (scale === 1) {
    return strip;
  }
  const scaled = document.createElement("canvas");
  scaled.width = strip.width * scale;
  scaled.height = strip.height * scale;
  const scaledCtx = get2DContext(scaled);
  scaledCtx.imageSmoothingEnabled = false; // keep pixel art crisp
  scaledCtx.drawImage(strip, 0, 0, scaled.width, scaled.height);
  return scaled;
}

/**
 * Build a ZIP of contact sheets for the selected animation: one PNG per
 * direction (or just the chosen direction) plus `credits.txt`, so the derived
 * PNGs always ship with their attribution.
 */
export async function buildContactSheetZip(
  state: State,
  options: Pick<AnimationExportOptions, "animation" | "direction" | "scale">,
  creditsText: string,
): Promise<Blob> {
  if (!canvas) {
    throw new Error("offscreen canvas not ready");
  }
  if (!window.JSZip) {
    throw new Error("JSZip library not loaded");
  }
  selectExportAnimation(options);
  const preview = getPreviewAnimationState();
  const rows =
    options.direction === "all"
      ? (DIRECTIONS.slice(0, preview.rowNum) as Exclude<
          AnimationDirection,
          "all"
        >[])
      : [options.direction as Exclude<AnimationDirection, "all">];

  const zip = new window.JSZip();
  const animationFolder = zip.folder(options.animation);
  for (const direction of rows) {
    const strip = composeDirectionStrip(state, direction, options.scale);
    animationFolder.file(`${direction}.png`, await canvasToBlob(strip));
  }
  zip.folder("credits").file("credits.txt", creditsText);
  return zip.generateAsync({ type: "blob" });
}
