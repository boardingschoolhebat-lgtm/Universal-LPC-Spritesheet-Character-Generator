import { expect } from "chai";
import { describe, it } from "mocha-globals";
import {
  buildLpcVideoCommand,
  expandPingPongFrames,
  isWebmSupported,
} from "../../sources/canvas/animation-export.ts";
import type { DrawCall } from "../../sources/canvas/renderer.ts";

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
