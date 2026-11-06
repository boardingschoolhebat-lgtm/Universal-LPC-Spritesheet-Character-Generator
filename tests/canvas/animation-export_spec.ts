import { expect } from "chai";
import JSZip from "jszip";
import sinon from "sinon";
import { describe, it, beforeEach, afterEach } from "mocha-globals";
import {
  buildContactSheetZip,
  buildLpcVideoCommand,
  expandPingPongFrames,
  exportAnimationGif,
  isWebmSupported,
} from "../../sources/canvas/animation-export.ts";
import {
  getPreviewAnimationState,
  setPreviewAnimation,
} from "../../sources/canvas/preview-animation.ts";
import {
  canvas as rendererCanvas,
  initCanvas,
  resetOffscreenCanvasStateForTests,
} from "../../sources/canvas/renderer.ts";
import {
  ANIMATION_CONFIGS,
  DIRECTIONS,
  FRAME_SIZE,
} from "../../sources/state/constants.ts";
import { createState, type State } from "../../sources/state/state.ts";
import type { DrawCall } from "../../sources/canvas/renderer.ts";

/** One opaque colour per LPC direction row, in `DIRECTIONS` order. */
const ROW_COLORS: Record<string, [number, number, number]> = {
  up: [255, 0, 0],
  left: [0, 255, 0],
  down: [0, 0, 255],
  right: [255, 255, 0],
};

function drawCall(overrides: Partial<DrawCall> = {}): DrawCall {
  return {
    itemId: "body",
    variant: null,
    zPos: 0,
    layerNum: 0,
    animation: "walk",
    yPos: 0,
    source: {
      kind: "catalog",
      spritePath: "spritesheets/body/male/universal-light.png",
    },
    ...overrides,
  };
}

describe("canvas/animation-export.ts", () => {
  describe("buildLpcVideoCommand", () => {
    it("writes the bottom catalog spritesheet as the base file and upper catalog layers as --layer arguments", () => {
      const draws = [
        drawCall({ itemId: "legs", animation: "walk" }),
        drawCall({
          itemId: "belts",
          layerNum: 2,
          animation: "walk",
          source: {
            kind: "catalog",
            spritePath: "spritesheets/belts/male/leather.png",
          },
        }),
      ];
      const command = buildLpcVideoCommand(
        { animation: "walk", direction: "down", fps: 8, scale: 2 },
        draws,
      );
      expect(command).to.include("node tools/video/lpc-video.ts");
      expect(command).to.include("spritesheets/body/male/universal-light.png");
      expect(command).to.include("--layer spritesheets/belts/male/leather.png");
      expect(command).to.include("--direction down --cycle walk --fps 8");
      expect(command).to.include("--scale 2 --out walk.gif");
    });

    it("skips custom-uploaded layers from --layer and explains they need manual handling", () => {
      const draws = [
        drawCall({ itemId: "body", animation: "walk" }),
        drawCall({
          itemId: "access",
          layerNum: 2,
          animation: "walk",
          source: { kind: "custom", image: new Image() },
        }),
      ];
      const command = buildLpcVideoCommand(
        { animation: "walk", direction: "all", fps: 8, scale: 2 },
        draws,
      );
      expect(command).to.include("# note:");
      expect(command).to.not.include("--layer");
    });

    it("exports a single chosen direction verbatim", () => {
      const command = buildLpcVideoCommand(
        { animation: "spellcast", direction: "left", fps: 4, scale: 1 },
        [drawCall({ animation: "spellcast" })],
      );
      expect(command).to.include("--direction left --cycle spellcast");
    });

    it("explains when the animation has no spritesheet layers", () => {
      const command = buildLpcVideoCommand(
        { animation: "cast", direction: "down", fps: 8, scale: 2 },
        [drawCall({ animation: "walk" })],
      );
      expect(command).to.include("# no spritesheets found for");
    });
  });

  describe("expandPingPongFrames", () => {
    it("appends the reversed cycle without repeating the first or last frame", () => {
      expect(expandPingPongFrames([0, 1, 2, 3], true)).to.deep.equal([
        0, 1, 2, 3, 2, 1,
      ]);
    });

    it("keeps short cycles (fewer than 3 frames) unexpanded", () => {
      expect(expandPingPongFrames([0, 1], true)).to.deep.equal([0, 1]);
      expect(expandPingPongFrames([9], true)).to.deep.equal([9]);
    });

    it("returns a copy of the frames when ping-pong is off", () => {
      const frames = [0, 1, 2];
      const expanded = expandPingPongFrames(frames, false);
      expect(expanded).to.deep.equal(frames);
      frames.push(3);
      expect(expanded).to.deep.equal([0, 1, 2]);
    });
  });

  describe("frame composition", function () {
    this.timeout(15_000);

    let state: State;
    let previousJSZip: Window["JSZip"];

    /** Paint one solid colour per direction row of the walk band. */
    function fillWalkBand(): void {
      const sheet = rendererCanvas;
      if (!sheet) throw new Error("renderer canvas missing");
      const ctx = sheet.getContext("2d");
      if (!ctx) throw new Error("2d context missing");
      ctx.clearRect(0, 0, sheet.width, sheet.height);
      const walk = ANIMATION_CONFIGS.walk as { row: number };
      DIRECTIONS.forEach((direction, index) => {
        const [r, g, b] = ROW_COLORS[direction];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(
          0,
          (walk.row + index) * FRAME_SIZE,
          sheet.width,
          FRAME_SIZE,
        );
      });
    }

    async function gifSize(blob: Blob): Promise<{
      width: number;
      height: number;
    }> {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
      };
    }

    /** RGBA of one exported pixel, decoded back through an image element. */
    async function framePixel(blob: Blob, x = 2, y = 2): Promise<number[]> {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      try {
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("2d context missing");
        ctx.drawImage(img, 0, 0);
        return Array.from(ctx.getImageData(x, y, 1, 1).data);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    beforeEach(() => {
      state = createState();
      state.applyTransparencyMask = false;
      initCanvas();
      fillWalkBand();
      setPreviewAnimation("walk");
      previousJSZip = window.JSZip;
      window.JSZip = JSZip as unknown as NonNullable<Window["JSZip"]>;
    });

    afterEach(() => {
      window.JSZip = previousJSZip;
      setPreviewAnimation("walk");
      resetOffscreenCanvasStateForTests();
    });

    it('keeps every direction row in one GIF frame when direction is "all"', async () => {
      const blob = exportAnimationGif(state, {
        animation: "walk",
        direction: "all",
        fps: 8,
        scale: 2,
        pingpong: false,
      });
      const preview = getPreviewAnimationState();
      const { width, height } = await gifSize(blob);
      expect(width).to.equal(preview.frameSize * preview.rowNum * 2);
      expect(height).to.equal(preview.frameSize * 2);
    });

    it("exports a single direction at one frame cell wide", async () => {
      const blob = exportAnimationGif(state, {
        animation: "walk",
        direction: "down",
        fps: 8,
        scale: 1,
        pingpong: false,
      });
      const { width, height } = await gifSize(blob);
      expect(width).to.equal(getPreviewAnimationState().frameSize);
      expect(height).to.equal(getPreviewAnimationState().frameSize);
    });

    it("writes one contact-sheet strip per direction with that row's pixels", async () => {
      const zipBlob = await buildContactSheetZip(
        state,
        { animation: "walk", direction: "all", scale: 1 },
        "credits for the contact sheets",
      );
      const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
      expect(zip.file("credits/credits.txt")).to.not.equal(null);
      for (const direction of DIRECTIONS) {
        const file = zip.file(`walk/${direction}.png`);
        expect(file).to.not.equal(null);
        const pixel = await framePixel(await file!.async("blob"));
        expect(pixel.slice(0, 3)).to.deep.equal(ROW_COLORS[direction]);
      }
    });

    it("writes only the chosen direction's strip when one direction is asked for", async () => {
      const zipBlob = await buildContactSheetZip(
        state,
        { animation: "walk", direction: "down", scale: 1 },
        "single direction credits",
      );
      const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
      expect(zip.file("walk/down.png")).to.not.equal(null);
      expect(zip.file("walk/up.png")).to.equal(null);
      expect(zip.file("walk/left.png")).to.equal(null);
      expect(zip.file("walk/right.png")).to.equal(null);
    });

    it("fills the requested background colour behind transparent frames", async () => {
      const gif = exportAnimationGif(state, {
        animation: "idle",
        direction: "all",
        fps: 8,
        scale: 1,
        pingpong: false,
        background: "#ff0000",
      });
      expect(await framePixel(gif, 0, 0)).to.deep.equal([255, 0, 0, 255]);
    });

    it("leaves empty pixels transparent when no background is set", async () => {
      const gif = exportAnimationGif(state, {
        animation: "idle",
        direction: "all",
        fps: 8,
        scale: 1,
        pingpong: false,
      });
      const pixel = await framePixel(gif, 0, 0);
      expect(pixel[3]).to.equal(0);
    });

    it("refuses the contact sheet when JSZip is not loaded", async () => {
      window.JSZip = undefined;
      let error: unknown = null;
      try {
        await buildContactSheetZip(
          state,
          { animation: "walk", direction: "all", scale: 1 },
          "credits",
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal("JSZip library not loaded");
    });

    it("refuses both exports before the offscreen canvas exists", async () => {
      resetOffscreenCanvasStateForTests();
      let gifError: unknown = null;
      try {
        exportAnimationGif(state, {
          animation: "walk",
          direction: "all",
          fps: 8,
          scale: 1,
          pingpong: false,
        });
      } catch (caught) {
        gifError = caught;
      }
      expect((gifError as Error)?.message).to.equal(
        "offscreen canvas not ready",
      );
      let error: unknown = null;
      try {
        await buildContactSheetZip(
          state,
          { animation: "walk", direction: "all", scale: 1 },
          "credits",
        );
      } catch (caught) {
        error = caught;
      }
      expect((error as Error)?.message).to.equal("offscreen canvas not ready");
    });

    it("refuses an animation the preview does not know", () => {
      const errorStub = sinon.stub(console, "error");
      let error: unknown = null;
      try {
        exportAnimationGif(state, {
          animation: "not-an-animation",
          direction: "all",
          fps: 8,
          scale: 1,
          pingpong: false,
        });
      } catch (caught) {
        error = caught;
      } finally {
        errorStub.restore();
      }
      expect((error as Error)?.message).to.equal(
        'unknown animation "not-an-animation"',
      );
    });
  });

  describe("isWebmSupported", () => {
    it("matches the browser's MediaRecorder WebM capability", () => {
      const supported = isWebmSupported();
      if (typeof MediaRecorder === "undefined") {
        expect(supported).to.equal(false);
      } else {
        const candidates = [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
        ];
        expect(supported).to.equal(
          candidates.some((mime) => MediaRecorder.isTypeSupported(mime)),
        );
      }
    });
  });
});
