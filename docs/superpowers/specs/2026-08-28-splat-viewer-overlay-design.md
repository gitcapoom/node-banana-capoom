# Splat viewer foreground overlay

**Date:** 2026-08-28
**Status:** approved, not yet implemented
**Repos:** `node-banana-capoom` and `capoom-splat-viewer` (formerly `gitcapoom/splat-viewer`)

## Problem

Framing a splat capture against a foreground plate is currently blind. You fly the
camera in the viewer, capture, wire the result into a Comp node, discover the
alignment is wrong, and go back. The plate you are matching to is never visible
while you are choosing the shot.

Separately, the viewer has no way to show a reference image at all, even for
someone using it standalone with no node graph.

## Goals

- See a foreground plate over the live 3D view while flying the camera.
- Get a composited frame out of a capture, alongside the clean plate.
- Work standalone, not only when driven by node-banana.

## Non-goals

- A general compositing surface in the viewer. Straight `over` only: no merge
  ops, no blend modes, no per-channel control. node-banana already has a Comp
  node for that, and a second implementation in another repo is a drift risk —
  the same one that produced two copies of the grade control and let `blur`
  fall out of sync between `imageFieldMap` and `imageStorage`.
- Transforming the overlay. Fit is automatic and centred (see Decisions).
- Persisting the overlay image in viewer state.

---

## Decisions

### The overlay is a viewer feature, not a node-banana appendage

It has its own state and UI in the viewer, with two supply paths. node-banana
becomes one consumer rather than the reason the feature exists. This is what the
"standalone as well" requirement buys: a clean interface instead of a
node-banana-shaped hook.

### One RGBA image internally, combined once

The two supply paths differ in shape:

| path | supplies |
|---|---|
| standalone | one RGBA image, alpha already baked in |
| node-banana | FG and FG_alpha as two separate images |

A browser cannot apply a separate matte to an `<img>`, so the node-banana path
combines FG + FG_alpha into a single RGBA data URL **once, on receipt**. From
that point both paths are identical, and there is exactly one representation to
reason about.

### Compositing happens in the viewer

Chosen deliberately over compositing in node-banana. The trade was stated and
accepted: the viewer's composite is an 8-bit canvas draw with no premultiply
control, and compositing logic now exists in two repos. What it buys is that the
frame you lined up is the frame you get.

The mitigation is the non-goal above — keeping the viewer's version to straight
`over` with no options means there is very little that *can* drift.

### The same code draws the overlay and the composite

Opacity and fit are applied by one function used for both. If the live overlay
and the capture composite compute their placement separately they will
eventually disagree, and WYSIWYG was the entire reason for compositing here.

### Fit: inside, centred

The capture is cropped to the viewer's selected aspect ratio; an overlay will
often be a different shape. The overlay is scaled to fit inside the frame,
preserving aspect, and centred. No stretch, no crop, no manual transform.

### The overlay image is not persisted

Viewer state already excludes `fileData` for size reasons and syncs through
`localStorage` plus a `postMessage` to the parent. An overlay is easily
megabytes. node-banana re-supplies it on open; a standalone user re-loads it.

---

## Architecture

```
STANDALONE                          NODE-BANANA
file / drag-drop                    spzViewer node
   │ one RGBA image                    │ FG + FG_alpha (two pins)
   │                                   │ sessionStorage: splat-viewer-fg-<worldId>
   │                                   │ postMessage: splat-viewer-fg (live updates)
   ▼                                   ▼
   └──────────► foregroundOverlay.ts ◄─┘  combine → one RGBA image
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   live overlay draw           capture composite
   (over the canvas)           (same fit + opacity)
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                 opener present:              standalone:
                 payload gains                downloads raw
                 compositeImage               and composite
                        │
                        ▼
                 node-banana spawns a third
                 imageInput node (<name>_comp.png)
```

### Viewer: `src/foregroundOverlay.ts` (new)

`SplatViewer.tsx` is 5,656 lines. The overlay gets its own module, alongside the
existing standalone modules (`cameraAnimation.ts`, `colmapIO.ts`).

Exports:

- `combineWithMatte(fg, alpha): Promise<string>` — FG + matte into one RGBA data
  URL. Used only by the node-banana path.
- `fitInside(srcW, srcH, dstW, dstH): { x, y, w, h }` — placement, pure.
- `drawOverlay(ctx, img, dstW, dstH, opacity)` — the single draw used by both the
  live overlay and the capture composite.

### Viewer: `SplatViewer.tsx` (changed)

- Overlay state: image, visible, opacity.
- UI: load button + drag-drop target, `O` to toggle, opacity slider.
- **New inbound `message` listener.** The viewer currently only posts outward; it
  has no listener at all. Needed for live FG updates while the window is open.
- On open, read `sessionStorage["splat-viewer-fg-<worldId>"]`.
- In the capture path (~`SplatViewer.tsx:3700-3770`), after the RGB offscreen
  canvas is built and before `toDataURL`, produce a second canvas with the
  overlay drawn on top when one is loaded.

### node-banana: `SpzViewerNode.tsx` (changed)

- Two input pins: `image-fg` and `image-fg_alpha`.
- `getNodeHandles("spzViewer")` gains them (`WorkflowCanvas.tsx:259`).
- Write the handoff to `sessionStorage` before `window.open`; post updates while
  open.
- In the capture handler, when the payload carries `compositeImage`, spawn a
  third `imageInput` node and save it to `inputs/` exactly as the RGB and depth
  nodes are.

**Note on the existing output pin:** `spzViewer`'s `image` output is dead —
`capturedImage` is only ever assigned `null` (three sites), and `getSourceOutput`
reads that field, so anything wired to it receives null. Captures leave this node
by spawning `imageInput` nodes. This spec does not repair that pin; the composite
follows the pattern that actually works. Repairing it is a separate change with
its own blast radius, since anything relying on that emptiness would start
receiving data.

---

## Data flow

1. FG and FG_alpha are wired to the spzViewer node.
2. On open, node-banana writes the pair to `sessionStorage` and opens the viewer.
3. The viewer reads them, combines them into one RGBA image, and shows it over
   the 3D view at the current opacity.
4. The user flies the camera with the plate visible.
5. On capture, the viewer produces the raw frame and — because an overlay is
   loaded — a composite, using the same fit and opacity.
6. `postMessage` carries `image`, `depthImage` (optional) and `compositeImage`.
7. node-banana spawns an `imageInput` node per returned image and saves each to
   `inputs/`.

## Error handling

| case | behaviour |
|---|---|
| no overlay | payload byte-identical to today; no extra node, no extra download |
| FG wired, no alpha | treated as opaque |
| alpha wired, no FG | ignored |
| image fails to decode | overlay off, capture unaffected, message logged |
| `sessionStorage` write fails (quota) | viewer opens without an overlay; node-banana logs it |
| viewer open, FG changes | `postMessage` updates it live; no reopen needed |

## Testing

**Viewer** — `fitInside` and the opacity maths are pure and unit-testable:
aspect-preserving placement, centring, an overlay wider than the frame, taller
than the frame, and exact-match dimensions. `combineWithMatte` round-trips a
known matte. The actual draw needs a browser; no test in either repo renders a
canvas.

**node-banana** — the pins resolve through `getConnectedInputs`; the handoff is
written before `window.open`; a capture payload carrying `compositeImage` spawns
exactly one extra node and one without spawns none. Follow the store-mock
pattern in `src/components/__tests__/ImageCropNode.test.tsx`.

**Browser only** — that the overlay is positioned identically in the live view
and in the composite. That is the claim the whole design rests on and no test
can make it.

## Rollout

Two repos, two commits. The viewer ships through the OTOSERVE10 deploy script
(`C:\caddy\deploy-splat-viewer.ps1`); node-banana picks it up on next open with
no rebuild, because it consumes the hosted build through the `/viewer`
reverse-proxy.

Ship the viewer first. If node-banana lands first, the pins exist and the handoff
is written, but the viewer ignores both — pins that visibly do nothing. Shipping
the viewer first is invisible until node-banana catches up: a standalone user
gains the overlay, and nothing else changes.
