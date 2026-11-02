import m from "mithril";
import type {
  AnimationExportUiOptions,
  ClipboardCommandResult,
  DownloadModel,
} from "../../models/download.ts";
import { CollapsibleSection } from "../CollapsibleSection.ts";

function reportClipboardResult(
  result: ClipboardCommandResult,
  successMessage: string,
  errorLogMessage: string,
  failureMessage: string,
): void {
  if (result.kind === "success") {
    alert(successMessage);
  } else if (result.kind === "failure") {
    console.error(errorLogMessage, result.error);
    alert(failureMessage);
  }
}

type AnimationExportRowState = {
  running: boolean;
  webmRunning: boolean;
  contactRunning: boolean;
  preset: AnimationPreset;
  direction: AnimationExportUiOptions["direction"];
  fps: number;
  scale: number;
  pingpong: boolean;
};

const ANIMATION_FPS_CHOICES = [4, 8, 12] as const;
const ANIMATION_SCALE_CHOICES = [1, 2, 3, 4, 6] as const;

/** Named export presets; anything not listed counts as "custom". */
type AnimationPreset = "custom" | "idle" | "walk" | "battle" | "showcase";

const ANIMATION_PRESETS: Record<
  Exclude<AnimationPreset, "custom">,
  { readonly fps: number; readonly scale: number; readonly pingpong: boolean }
> = {
  idle: { fps: 4, scale: 1, pingpong: true },
  walk: { fps: 8, scale: 2, pingpong: true },
  battle: { fps: 12, scale: 2, pingpong: false },
  showcase: { fps: 12, scale: 4, pingpong: true },
};

const ANIMATION_PRESET_LABELS: Record<AnimationPreset, string> = {
  custom: "Custom",
  idle: "Idle loop (4 FPS · 1×)",
  walk: "Walk cycle (8 FPS · 2×)",
  battle: "Battle cycle (12 FPS · 2×)",
  showcase: "Showcase (12 FPS · 4×)",
};

const AnimationExportControls: m.Component<
  { model: DownloadModel },
  AnimationExportRowState
> = {
  oninit(vnode) {
    vnode.state.running = false;
    vnode.state.webmRunning = false;
    vnode.state.contactRunning = false;
    vnode.state.preset = "walk";
    vnode.state.direction = "all";
    vnode.state.fps = 8;
    vnode.state.scale = 2;
    vnode.state.pingpong = true;
  },
  view(vnode) {
    const { model } = vnode.attrs;
    const state = vnode.state;
    const options = (): AnimationExportUiOptions => ({
      direction: state.direction,
      fps: state.fps,
      scale: state.scale,
      pingpong: state.pingpong,
    });
    return m("div.field.is-horizontal", [
      m("div.field-label.is-normal", [
        m("label.label.mb-0", "Animation (GIF)"),
      ]),
      m("div.field-body.is-flex-wrap-wrap", [
        m("div.field.is-flex.is-flex-wrap-wrap", [
          m("div.control", [
            m("div.select.is-small", [
              m(
                "select",
                {
                  "aria-label": "Animation export preset",
                  value: state.preset,
                  onchange: (e: Event) => {
                    const preset = (e.target as HTMLSelectElement)
                      .value as AnimationPreset;
                    state.preset = preset;
                    if (preset !== "custom") {
                      const presetOptions = ANIMATION_PRESETS[preset];
                      state.fps = presetOptions.fps;
                      state.scale = presetOptions.scale;
                      state.pingpong = presetOptions.pingpong;
                    }
                  },
                },
                (Object.keys(ANIMATION_PRESET_LABELS) as AnimationPreset[]).map(
                  (preset) =>
                    m(
                      "option",
                      { value: preset },
                      ANIMATION_PRESET_LABELS[preset],
                    ),
                ),
              ),
            ]),
          ]),
          m("div.control", [
            m("div.select.is-small", [
              m(
                "select",
                {
                  "aria-label": "Animation export direction",
                  value: state.direction,
                  onchange: (e: Event) => {
                    state.direction = (e.target as HTMLSelectElement)
                      .value as AnimationExportUiOptions["direction"];
                  },
                },
                [
                  m(
                    "option",
                    { value: "all" },
                    "All directions (side by side)",
                  ),
                  m("option", { value: "up" }, "Up"),
                  m("option", { value: "left" }, "Left"),
                  m("option", { value: "down" }, "Down"),
                  m("option", { value: "right" }, "Right"),
                ],
              ),
            ]),
          ]),
          m("div.control", [
            m("div.select.is-small", [
              m(
                "select",
                {
                  "aria-label": "Animation export fps",
                  value: state.fps,
                  onchange: (e: Event) => {
                    state.fps = parseInt(
                      (e.target as HTMLSelectElement).value,
                      10,
                    );
                    state.preset = "custom";
                  },
                },
                ANIMATION_FPS_CHOICES.map((fps) =>
                  m("option", { value: fps }, `${fps} FPS`),
                ),
              ),
            ]),
          ]),
          m("div.control", [
            m("div.select.is-small", [
              m(
                "select",
                {
                  "aria-label": "Animation export scale",
                  value: state.scale,
                  onchange: (e: Event) => {
                    state.scale = parseInt(
                      (e.target as HTMLSelectElement).value,
                      10,
                    );
                    state.preset = "custom";
                  },
                },
                ANIMATION_SCALE_CHOICES.map((scale) =>
                  m("option", { value: scale }, `${scale}×`),
                ),
              ),
            ]),
          ]),
          m("div.control", [
            m(
              "label.checkbox",
              m("input[type=checkbox]", {
                checked: state.pingpong,
                onchange: (e: Event) => {
                  state.pingpong = (e.target as HTMLInputElement).checked;
                  state.preset = "custom";
                },
              }),
              " ping-pong",
            ),
          ]),
        ]),
      ]),
      m("div.field", [
        m("div.control", [
          m(
            "button.button.is-small.is-primary",
            {
              disabled: state.running,
              onclick: () => {
                state.running = true;
                try {
                  model.exportAnimationGif(options());
                } finally {
                  state.running = false;
                }
              },
            },
            state.running ? "Exporting…" : "Animation (GIF)",
          ),
        ]),
        m("div.control", [
          m(
            "button.button.is-small.is-secondary",
            {
              title:
                "Recorded live via MediaRecorder; transparency may be lost",
              disabled: vnode.state.webmRunning,
              onclick: async () => {
                vnode.state.webmRunning = true;
                try {
                  await model.exportAnimationWebM(options());
                } catch (error) {
                  console.error("Failed to export animation WebM:", error);
                  alert(
                    "Failed to export animation WebM. See the console for details.",
                  );
                } finally {
                  vnode.state.webmRunning = false;
                }
              },
            },
            vnode.state.webmRunning ? "Recording…" : "Animation (WebM)",
          ),
        ]),
        m("div.control", [
          m(
            "button.button.is-small.is-info",
            {
              title:
                "One PNG strip per direction with all cycle frames, plus credits",
              disabled: state.contactRunning,
              onclick: async () => {
                state.contactRunning = true;
                try {
                  await model.exportAnimationContactSheet(options());
                } finally {
                  state.contactRunning = false;
                }
              },
            },
            state.contactRunning ? "Packing…" : "Contact-sheet ZIP",
          ),
        ]),
        m("div.control", [
          m(
            "button.button.is-small.is-link",
            {
              onclick: async () =>
                reportClipboardResult(
                  await model.copyAnimationCliCommand(options()),
                  "CLI command copied to clipboard!",
                  "Failed to copy CLI command to clipboard:",
                  "Failed to copy CLI command. Please check browser permissions.",
                ),
            },
            "Copy CLI command",
          ),
        ]),
      ]),
    ]);
  },
};

const DownloadContent: m.Component<{
  createModel: () => DownloadModel;
}> = {
  view(vnode) {
    const model = vnode.attrs.createModel();
    return m("div", [
      m("div.buttons.is-flex.is-flex-wrap-wrap", { id: "download-buttons" }, [
        m(
          "button.button.is-small.is-primary",
          { onclick: model.saveSpritesheet },
          "Spritesheet (PNG)",
        ),
        m(
          "button.button.is-small",
          { onclick: model.downloadCreditsTxt },
          "Credits (TXT)",
        ),
        m(
          "button.button.is-small",
          { onclick: model.downloadCreditsCsv },
          "Credits (CSV)",
        ),
        m(
          "button.button.is-small.is-info",
          {
            disabled: model.zipDisabled,
            title: model.zipTitle,
            onclick: model.exportZipByAnimation,
          },
          "ZIP: Split by animation",
        ),
        model.zipByAnimationRunning ? m("span.loading") : null,
        m(
          "button.button.is-small.is-info",
          {
            disabled: model.zipDisabled,
            title: model.zipTitle,
            onclick: model.exportZipByItem,
          },
          "ZIP: Split by item",
        ),
        model.zipByItemRunning ? m("span.loading") : null,
        m(
          "button.button.is-small.is-info",
          {
            disabled: model.zipDisabled,
            title: model.zipTitle,
            onclick: model.exportZipByAnimationAndItem,
          },
          "ZIP: Split by animation and item",
        ),
        model.zipByAnimationAndItemRunning ? m("span.loading") : null,
        m(
          "button.button.is-small.is-info",
          {
            disabled: model.zipDisabled,
            title: model.zipTitle,
            onclick: model.exportZipByAnimationAndFrame,
          },
          "ZIP: Split by animation and frame",
        ),
        model.zipIndividualFramesRunning ? m("span.loading") : null,
        m(
          "button.button.is-small.is-link",
          {
            onclick: async () =>
              reportClipboardResult(
                await model.exportJsonToClipboard(),
                "Exported to clipboard!",
                "Failed to copy to clipboard:",
                "Failed to copy to clipboard. Please check browser permissions.",
              ),
          },
          "Export to Clipboard (JSON)",
        ),
        m(
          "button.button.is-small.is-link",
          {
            onclick: async () =>
              reportClipboardResult(
                await model.importJsonFromClipboard(),
                "Imported successfully!",
                "Failed to import from clipboard:",
                "Failed to import. Please check clipboard content and browser permissions.",
              ),
          },
          "Import from Clipboard (JSON)",
        ),
      ]),
      m(AnimationExportControls, { model }),
    ]);
  },
};

export const Download: m.Component<{
  createModel: () => DownloadModel;
}> = {
  view(vnode) {
    return m(
      CollapsibleSection,
      { title: "Download", defaultOpen: true },
      m(DownloadContent, { createModel: vnode.attrs.createModel }),
    );
  },
};
