import {
  downloadAsPNG,
  downloadBlob,
  downloadFile,
} from "../canvas/download.ts";
import {
  buildContactSheetZip,
  buildLpcVideoCommand,
  exportAnimationGif,
  exportAnimationWebM,
  isWebmSupported,
  type AnimationDirection,
} from "../canvas/animation-export.ts";
import { drawCalls } from "../canvas/renderer.ts";
import type { CatalogReader } from "../state/catalog.ts";
import {
  exportStateAsJSON,
  importStateFromJSON,
  serializeLayersForJson,
} from "../state/json.ts";
import type { State } from "../state/state.ts";
import {
  exportIndividualFrames,
  exportSplitAnimations,
  exportSplitItemAnimations,
  exportSplitItemSheets,
} from "../state/zip.ts";
import { creditsToCsv, creditsToTxt, getAllCredits } from "../utils/credits.ts";
import { debugLog } from "../utils/debug.ts";

export type ClipboardCommandResult =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: unknown }
  | { readonly kind: "unavailable" };

export type AnimationExportUiOptions = {
  readonly direction: AnimationDirection;
  readonly fps: number;
  readonly scale: number;
  readonly pingpong: boolean;
};

export type DownloadModel = {
  readonly zipDisabled: boolean;
  readonly zipTitle?: string;
  readonly zipByAnimationRunning: boolean;
  readonly zipByItemRunning: boolean;
  readonly zipByAnimationAndItemRunning: boolean;
  readonly zipIndividualFramesRunning: boolean;
  saveSpritesheet(): void;
  exportAnimationGif(options: AnimationExportUiOptions): void;
  /** Resolves after the MediaRecorder run; rejects when WebM is unsupported. */
  exportAnimationWebM(options: AnimationExportUiOptions): Promise<void>;
  readonly webmSupported: boolean;
  /** Builds a ZIP of per-direction PNG strips for the selected animation. */
  exportAnimationContactSheet(options: AnimationExportUiOptions): Promise<void>;
  copyAnimationCliCommand(
    options: AnimationExportUiOptions,
  ): Promise<ClipboardCommandResult>;
  downloadCreditsTxt(): void;
  downloadCreditsCsv(): void;
  exportZipByAnimation(): Promise<void>;
  exportZipByItem(): Promise<void>;
  exportZipByAnimationAndItem(): Promise<void>;
  exportZipByAnimationAndFrame(): Promise<void>;
  exportJsonToClipboard(): Promise<ClipboardCommandResult>;
  importJsonFromClipboard(): Promise<ClipboardCommandResult>;
};

const zipExportTitle = "Wait for layer data to finish loading";

export const downloadModelFactory = {
  create(catalog: CatalogReader, state: State): DownloadModel {
    const zipDisabled = !catalog.isLayersReady();
    return {
      zipDisabled,
      zipTitle: zipDisabled ? zipExportTitle : undefined,
      zipByAnimationRunning: state.zipByAnimation.isRunning,
      zipByItemRunning: state.zipByItem.isRunning,
      zipByAnimationAndItemRunning: state.zipByAnimationAndItem.isRunning,
      zipIndividualFramesRunning: state.zipIndividualFrames.isRunning,
      webmSupported: isWebmSupported(),
      saveSpritesheet() {
        if (!window.canvasRenderer) return;
        downloadAsPNG("character-spritesheet.png");
      },
      exportAnimationGif(options) {
        if (!window.canvasRenderer) {
          alert("Wait for the character to finish rendering first.");
          return;
        }
        try {
          const blob = exportAnimationGif(state, {
            animation: state.selectedAnimation,
            fps: options.fps,
            scale: options.scale,
            direction: options.direction,
            pingpong: options.pingpong,
            background: null,
          });
          downloadBlob(blob, `character-${state.selectedAnimation}.gif`);
        } catch (error) {
          console.error("Failed to export animation GIF:", error);
          alert("Failed to export animation GIF. See the console for details.");
        }
      },
      exportAnimationWebM: async (options) => {
        if (!window.canvasRenderer) {
          alert("Wait for the character to finish rendering first.");
          return;
        }
        if (!isWebmSupported()) {
          alert(
            "This browser cannot record WebM video. Please use the GIF export instead.",
          );
          return;
        }
        const blob = await exportAnimationWebM(state, {
          animation: state.selectedAnimation,
          fps: options.fps,
          scale: options.scale,
          direction: options.direction,
          pingpong: options.pingpong,
          background: null,
        });
        downloadBlob(blob, `character-${state.selectedAnimation}.webm`);
      },
      async exportAnimationContactSheet(options) {
        if (!window.canvasRenderer) {
          alert("Wait for the character to finish rendering first.");
          return;
        }
        try {
          const credits = getAllCredits(
            catalog,
            state.selections,
            state.bodyType,
          );
          const blob = await buildContactSheetZip(
            state,
            {
              animation: state.selectedAnimation,
              direction: options.direction,
              scale: options.scale,
            },
            creditsToTxt(credits),
          );
          downloadBlob(
            blob,
            `character-${state.selectedAnimation}-contact-sheet.zip`,
          );
        } catch (error) {
          console.error("Failed to export contact sheet ZIP:", error);
          alert(
            "Failed to export contact sheet ZIP. See the console for details.",
          );
        }
      },
      async copyAnimationCliCommand(options) {
        if (!window.canvasRenderer) return { kind: "unavailable" };
        try {
          const command = buildLpcVideoCommand(
            {
              animation: state.selectedAnimation,
              direction: options.direction,
              fps: options.fps,
              scale: options.scale,
            },
            drawCalls,
          );
          await navigator.clipboard.writeText(command);
          return { kind: "success" };
        } catch (error) {
          return { kind: "failure", error };
        }
      },
      downloadCreditsTxt() {
        const credits = getAllCredits(
          catalog,
          state.selections,
          state.bodyType,
        );
        downloadFile(creditsToTxt(credits), "credits.txt", "text/plain");
      },
      downloadCreditsCsv() {
        const credits = getAllCredits(
          catalog,
          state.selections,
          state.bodyType,
        );
        downloadFile(creditsToCsv(credits), "credits.csv", "text/csv");
      },
      exportZipByAnimation: () => exportSplitAnimations(catalog, state),
      exportZipByItem: () => exportSplitItemSheets(catalog, state),
      exportZipByAnimationAndItem: () =>
        exportSplitItemAnimations(catalog, state),
      exportZipByAnimationAndFrame: () =>
        exportIndividualFrames(catalog, state),
      async exportJsonToClipboard() {
        if (!window.canvasRenderer) return { kind: "unavailable" };
        try {
          const json = exportStateAsJSON(
            catalog,
            state,
            serializeLayersForJson(drawCalls),
          );
          debugLog(json);
          await navigator.clipboard.writeText(json);
          return { kind: "success" };
        } catch (error) {
          return { kind: "failure", error };
        }
      },
      async importJsonFromClipboard() {
        if (!window.canvasRenderer) return { kind: "unavailable" };
        try {
          const json = await navigator.clipboard.readText();
          debugLog(json);
          Object.assign(state, importStateFromJSON(catalog, state, json));
          return { kind: "success" };
        } catch (error) {
          return { kind: "failure", error };
        }
      },
    };
  },
};
