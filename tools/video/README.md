LPC Sheet to Video
=============================

Three small CLIs that turn LPC art into moving images:

| Command | Job |
| --- | --- |
| [`lpc-video.ts`](lpc-video.ts) | One sheet (or a folder of frames) → GIF / MP4 / WebM, plus an optional PNG sequence |
| [`lpc-batch.ts`](lpc-batch.ts) | A folder of per-animation sheets → one clip per animation, one run |
| [`lpc-reel.ts`](lpc-reel.ts) | A JSON manifest of clips → one concatenated video with gaps between clips |

The web app can generate a ready-made `lpc-video.ts` command for the currently
selected character: use the **Copy CLI command** button in the Download panel.
It composes the character's spritesheet paths from your selection, so you can
paste the command into a terminal and get the equivalent animation export. It
covers catalog layers only and explains that in the command's comment lines.

Slicing, layer stacking, trimming, styling and GIF encoding are pure Node: run
them with `node`, no `npm ci` needed. MP4 and WebM shell out to `ffmpeg`, which
must be on `PATH` or in the `FFMPEG` environment variable.

A sheet is a grid: each frame is `64×64`, columns are frames, and rows are the
facing directions in `up, left, down, right` order (`DIRECTIONS` in
[`sources/state/constants.ts`](../../sources/state/constants.ts)). Sheets with a
single row (`hurt`, `climb`) use that row for any direction.

## One sheet

```bash
# What is in this sheet?
node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png --list

# Walk cycle facing the camera, 4x nearest-neighbour, transparent GIF
node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png \
  --direction down --cycle walk --fps 8 --scale 4 --out walk.gif

# All four directions in a 2x2 grid
node tools/video/lpc-video.ts spritesheets/body/bodies/male/run.png \
  --direction all --scale 2 --out run-directions.gif

# Vertical-video cut: trim the empty padding, then letterbox into 9:16
node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png \
  --layer spritesheets/legs/pants/male/walk.png \
  --direction down --cycle walk --trim --fit 9:16 --bg '#202020' --out clip.gif

# Stickman render: solid silhouette plus a light outline
node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png \
  --layer spritesheets/legs/pants/male/walk.png \
  --direction down --cycle walk --style silhouette --ink '#202020' \
  --outline '#f5f5f5' --out stickman.gif

# MP4 on a solid background, plus a PNG sequence for DaVinci / Premiere
node tools/video/lpc-video.ts spritesheets/body/bodies/male/slash.png \
  --direction right --bg '#202020' --scale 4 --fps 12 \
  --out slash.mp4 --frames tmp/slash-frames

# A folder of frames (e.g. the "Individual frames" ZIP export)
node tools/video/lpc-video.ts path/to/standard/walk/down --fps 8 --out walk.gif
```

### Stacking layers

Raw repo sheets hold a single layer each, so `--input` is the bottom layer and
every `--layer` goes on top of it, in flag order — the same order the generator
draws body, clothes, head and hair:

```bash
node tools/video/lpc-video.ts spritesheets/body/bodies/male/walk.png \
  --layer spritesheets/legs/pants/male/walk.png \
  --layer spritesheets/torso/clothes/shortsleeve/tshirt/male/walk.png \
  --layer spritesheets/head/heads/human/male/walk.png \
  --layer spritesheets/hair/xlong/male/walk.png \
  --direction down --cycle walk --scale 6 --out character-walk.gif
```

Stacking happens per 64×64 cell, so layers whose sheet is narrower (fewer
columns) still line up; the shorter list sets the frame count.

### Options

| Option | Meaning |
| --- | --- |
| `--layer <png>` | Add a layer above `<input>`; repeatable, bottom → top |
| `--out <file>` | `.gif` (default `lpc.gif`), `.mp4`, or `.webm` |
| `--direction <d>` | `up`, `left`, `right`, `down` (default), or `all` for a 2x2 grid |
| `--cycle <anim>` | Use the app's own frame cycle from `ANIMATION_CONFIGS` (e.g. `walk` plays columns 1-8, skipping the duplicate rest frame) |
| `--row <n>` | Force a sheet row instead of deriving it from `--direction` |
| `--fps <n>` | Frames per second (default 8). GIF delays are rounded to centiseconds |
| `--scale <n>` | Nearest-neighbour upscale (default 4) so pixels stay blocky |
| `--loop <mode>` | `forward` (default) or `pingpong` — ping-pong suits locomotion cycles |
| `--hold <n>` | Repeat each frame `n` times for a slower, chunkier read |
| `--duration <sec>` | Repeat the cycle until this duration is filled |
| `--bg <#rrggbb>` | Composite onto a solid background instead of alpha |
| `--trim` | Crop every frame to the union box of all ink (animation stays registered) |
| `--fit <w:h>` | Center the scaled frame on an exact-ratio canvas (contain), e.g. `9:16`, `1:1` |
| `--style <mode>` | `normal` (default) or `silhouette` — posterize the figure to one flat ink |
| `--ink <#hex>` | Silhouette ink (default `#1a1a1a`) |
| `--outline <#hex>` | 1px outline around the silhouette (stickman look) |
| `--frames <dir>` | Also write `frame-0001.png` ... for video editors |
| `--list` | Print sheet size, grid, and which `--cycle` values fit |

## A whole folder

`lpc-batch.ts` renders every sheet in a folder, picking each animation's cycle
from its filename (`walk.png` → the `walk` cycle), so a full character pack
becomes a set of clips in one command:

```bash
# Every animation of the male body, as GIFs with layers
node tools/video/lpc-batch.ts spritesheets/body/bodies/male --out tmp/clips \
  --layer 'spritesheets/legs/pants/male/{name}.png' \
  --layer 'spritesheets/head/heads/human/male/{name}.png'

# Stickman MP4s, framed for vertical feeds
node tools/video/lpc-batch.ts tmp/pack --format mp4 --direction right \
  --trim --fit 9:16 --style silhouette --bg '#101010' --scale 4 --out tmp/mp4
```

Files are written as `<animation>-<direction>.<format>`. Sheets that are not a
64px grid are skipped with a warning; a failed clip does not stop the run, and
the command exits non-zero if any clip failed.

| Option | Meaning |
| --- | --- |
| `--out <dir>` | Output folder (default `lpc-clips`) |
| `--format <fmt>` | `gif` (default), `mp4`, or `webm` |
| `--layer <template>` | Layer added to every clip; `{name}` becomes the animation name |
| `--direction <d>`, `--fps`, `--scale`, `--loop`, `--hold`, `--duration`, `--bg` | Same meaning as the single-sheet tool |
| `--trim`, `--fit`, `--style`, `--ink`, `--outline` | Same meaning as the single-sheet tool |
| `--list` | Show what would be rendered, without rendering |

## A reel: several clips in one video

`lpc-reel.ts` reads a JSON manifest (paths relative to the manifest file) and
encodes *one* output with a gap between clips. Loop, hold and per-clip duration
are resolved per clip, and the visual options (`--trim`, `--fit`, `--style`,
...) are applied globally, so the whole video registers cleanly:

```json
{
  "fps": 12, "scale": 4, "bg": "#101010", "gap": 4, "gapMode": "freeze",
  "direction": "down",
  "clips": [
    { "sheet": "../spritesheets/body/bodies/male/walk.png",
      "layers": ["../spritesheets/legs/pants/male/walk.png"],
      "cycle": "walk", "duration": 1.5 },
    { "sheet": "../spritesheets/body/bodies/male/slash.png", "direction": "right" }
  ]
}
```

```bash
node tools/video/lpc-reel.ts plan.json --list            # preview frame counts
node tools/video/lpc-reel.ts plan.json --out reel.mp4 --bg '#101010'
```

| Option | Meaning |
| --- | --- |
| `--out <file>` | `.gif` (default), `.mp4`, or `.webm` |
| `--fps`, `--scale`, `--bg`, `--loop`, `--hold` | Override the manifest root |
| `--gap <n>` | Frames between clips (default 0) |
| `--gap-mode <mode>` | `freeze` (repeat the clip's last frame, default) or `blank` (empty frame) |
| `--trim` | Trim to the union box of **all** clips, so frame sizes stay identical |
| `--fit`, `--style`, `--ink`, `--outline` | Same meaning as the other tools |
| `--list` | Print the plan (frames and seconds per clip) without rendering |

Clip fields: `sheet` (required), `layers` (optional array, bottom-first),
`direction` (default: manifest root), `cycle` (default: the sheet's filename;
`null` plays all columns), `duration` seconds (default: one pass of the cycle),
`hold` and `loop` (default: manifest root).

## Choosing a format

| Format | Use it for | Alpha | Needs ffmpeg |
| --- | --- | --- | --- |
| `.gif` | Sharing in chat/issues/docs, sprite previews | 1-bit | no |
| `.mp4` | Editing in a video editor, uploading, long clips | no | yes |
| `.webm` | Web overlays that need soft transparency | yes (`yuva420p`) | yes |
| `--frames` | Frame-accurate work in DaVinci / Premiere / After Effects | full | no |

## Notes

- The PNG decoder handles every sheet in `spritesheets/`: 1, 2, 4 and 8-bit
  depth, greyscale, RGB, palette (with `tRNS`) and RGBA, non-interlaced.
- MP4 (`libx264`, `yuv420p`) has no alpha, so omitting `--bg` for MP4 falls back
  to white. GIF and WebM keep transparency. Solid-background GIFs keep their
  exact fill colour (the palette's transparent sentinel is reserved separately).
- GIF supports only 1-bit alpha; pixels below alpha 128 become transparent.
  Palettes are exact up to 254 colours, otherwise median-cut quantised.
- `--fit`/`--trim` run before `--frames`/encoding, so PNG sequences match the
  final crop as well.
- `--out` is resolved relative to the current directory; ffmpeg is run inside
  the frame folder, so relative paths and spaces are handled.
- These are derived from licensed LPC art: keep the `credits/` folder that the
  generator exports alongside any video you publish.
