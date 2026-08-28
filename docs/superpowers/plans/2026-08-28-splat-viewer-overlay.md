# Splat Viewer Foreground Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a foreground plate over the live 3D view while flying the camera, and get a composited frame out of a capture alongside the clean plate — working both standalone and driven by node-banana.

**Architecture:** The overlay is a feature of the viewer, with two supply paths that converge on one internal representation: a standalone RGBA image, or FG + FG_alpha from node-banana combined once on receipt. One function draws both the live overlay and the capture composite, so what you frame is what you get. node-banana adds two input pins, hands the pair to the viewer, and spawns an `imageInput` node from the returned composite.

**Tech Stack:** React + TypeScript + Three.js (viewer, Vite + vitest); Next.js 16 + React Flow + Zustand (node-banana, vitest + jsdom).

## Global Constraints

- **Two repos.** Viewer work is in `C:\Users\capoom\splat-viewer` (GitHub: `capoom-splat-viewer`). node-banana work is in `C:\Users\capoom\node-banana-capoom`. Never put viewer source in node-banana.
- **Ship the viewer first.** node-banana landing first gives pins that visibly do nothing.
- **Straight `over` only** in the viewer — no merge ops, no blend modes, no per-channel control. This is the mitigation for compositing living in two repos.
- **One draw function** serves the live overlay and the capture composite. Divergence breaks the WYSIWYG that justified compositing viewer-side.
- **Fit is inside-and-centred.** No stretch, no crop, no manual transform.
- **The overlay image is never persisted** to viewer `localStorage` state — it is easily megabytes, and that state already excludes `fileData` for the same reason.
- Matte luminance uses Rec.709 — `0.2126 R + 0.7152 G + 0.0722 B` — matching `lumToAlphaCanvas` in node-banana (`src/utils/compComposite.ts:325`) so a matte behaves identically in both.
- No overlay loaded ⇒ the capture payload is byte-identical to today.
- Viewer: `npm run test` (vitest) and `npm run typecheck` must pass. node-banana: `npx vitest run` and `npx tsc --noEmit` must pass.
- jsdom has no canvas and no WebGL in either repo. Do not write a test that asserts a mock was called and call it coverage.

---

## File Structure

**capoom-splat-viewer**

| File | Responsibility |
|---|---|
| `src/foregroundOverlay.ts` (create) | Fit maths, matte combining, the single draw. Pure where it can be. |
| `src/__tests__/foregroundOverlay.test.ts` (create) | Unit tests for the pure parts. |
| `src/SplatViewer.tsx` (modify) | Overlay state, UI, live DOM overlay, capture composite, inbound message listener. |

`SplatViewer.tsx` is 5,656 lines. All new logic that can live outside it does, following the existing standalone-module pattern (`cameraAnimation.ts`, `colmapIO.ts`).

**node-banana-capoom**

| File | Responsibility |
|---|---|
| `src/components/nodes/SpzViewerNode.tsx` (modify) | Two input pins, handoff, composite node spawn. |
| `src/components/WorkflowCanvas.tsx:259` (modify) | Declare the new pins. |
| `src/components/__tests__/SpzViewerNode.test.tsx` (create) | Pins resolve, handoff written, composite spawns a node. |

---

# PART A — capoom-splat-viewer (ship first)

### Task 1: Overlay module — fit maths and the single draw

**Files:**
- Create: `C:\Users\capoom\splat-viewer\src\foregroundOverlay.ts`
- Test: `C:\Users\capoom\splat-viewer\src\__tests__\foregroundOverlay.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FitBox`, `fitInside(srcW, srcH, dstW, dstH): FitBox`, `drawOverlay(ctx: CanvasRenderingContext2D, img: CanvasImageSource & {naturalWidth:number;naturalHeight:number}, dstW: number, dstH: number, opacity: number): void`, `combineWithMatte(fgUrl: string, alphaUrl: string | null): Promise<string>`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/foregroundOverlay.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { fitInside } from "../foregroundOverlay";

describe("fitInside", () => {
  it("scales a wide image to the frame width and centres it vertically", () => {
    // 2:1 source into a 1:1 frame -> full width, half height, centred.
    expect(fitInside(200, 100, 100, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  it("scales a tall image to the frame height and centres it horizontally", () => {
    expect(fitInside(100, 200, 100, 100)).toEqual({ x: 25, y: 0, w: 50, h: 100 });
  });

  it("leaves an exact-aspect image filling the frame", () => {
    expect(fitInside(400, 200, 200, 100)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it("scales UP a small image rather than pinning it at native size", () => {
    // The plate should fill the framing box; a 100x50 reference in a 400x200
    // frame is useless at native size.
    expect(fitInside(100, 50, 400, 200)).toEqual({ x: 0, y: 0, w: 400, h: 200 });
  });

  it("returns an empty box for degenerate dimensions rather than NaN", () => {
    expect(fitInside(0, 100, 100, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(fitInside(100, 100, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\capoom\splat-viewer && npx vitest run src/__tests__/foregroundOverlay.test.ts`
Expected: FAIL — `Failed to resolve import "../foregroundOverlay"`.

- [ ] **Step 3: Write the implementation**

`src/foregroundOverlay.ts`:

```typescript
/**
 * Foreground overlay for the splat viewer.
 *
 * Shows a plate over the live 3D view so a camera can be framed against it, and
 * burns that same plate into a capture. The live overlay and the capture
 * composite MUST agree — that agreement is the only reason compositing happens
 * here rather than in node-banana — so both go through `drawOverlay`, and both
 * place the image with `fitInside`.
 *
 * Deliberately straight `over` with no ops, no blend modes and no transform.
 * node-banana has a Comp node for real compositing; a second implementation here
 * is a drift risk, so there is as little of it as possible.
 */

export interface FitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Place a source rect inside a destination rect, preserving aspect and centring.
 *
 * Scales UP as well as down: the plate is a framing reference, so a small one
 * still has to fill the frame to be useful.
 */
export function fitInside(srcW: number, srcH: number, dstW: number, dstH: number): FitBox {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

/**
 * The single draw. Used for the capture composite; the live overlay uses the
 * same `fitInside` through CSS so the two land in the same place.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  dstW: number,
  dstH: number,
  opacity: number,
): void {
  const box = fitInside(img.naturalWidth, img.naturalHeight, dstW, dstH);
  if (box.w <= 0 || box.h <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.drawImage(img, box.x, box.y, box.w, box.h);
  ctx.globalAlpha = prev;
}

/** Load a data/blob URL into a decoded image. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("overlay image failed to decode"));
    img.src = url;
  });
}

/**
 * Fold a separate matte into the foreground's alpha channel, once.
 *
 * node-banana supplies FG and FG_alpha as two images, and a browser cannot apply
 * a separate matte to an `<img>`. Combining here means everything downstream —
 * the live overlay and the capture composite alike — works on one RGBA image.
 *
 * `destination-in` is NOT usable: it multiplies by the source's ALPHA, and a
 * greyscale matte PNG is fully opaque, so it would keep every pixel. The matte's
 * LUMINANCE is the coverage, using the Rec.709 weights node-banana's
 * `lumToAlphaCanvas` uses, so a matte behaves the same in both places.
 *
 * With no matte the foreground is returned unchanged — an FG with no alpha is
 * treated as opaque.
 */
export async function combineWithMatte(fgUrl: string, alphaUrl: string | null): Promise<string> {
  if (!alphaUrl) return fgUrl;

  const [fg, matte] = await Promise.all([loadImage(fgUrl), loadImage(alphaUrl)]);
  const w = fg.naturalWidth;
  const h = fg.naturalHeight;
  if (!w || !h) return fgUrl;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fgUrl;

  ctx.drawImage(fg, 0, 0);
  const fgData = ctx.getImageData(0, 0, w, h);

  // The matte is resampled to the foreground's size: the two need not match, and
  // the foreground defines the geometry.
  const mCanvas = document.createElement("canvas");
  mCanvas.width = w;
  mCanvas.height = h;
  const mCtx = mCanvas.getContext("2d", { willReadFrequently: true });
  if (!mCtx) return fgUrl;
  mCtx.drawImage(matte, 0, 0, w, h);
  const mData = mCtx.getImageData(0, 0, w, h);

  const d = fgData.data;
  const m = mData.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * m[i] + 0.7152 * m[i + 1] + 0.0722 * m[i + 2];
    d[i + 3] = Math.round((d[i + 3] * lum) / 255);
  }
  ctx.putImageData(fgData, 0, 0);
  return canvas.toDataURL("image/png");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\Users\capoom\splat-viewer && npx vitest run src/__tests__/foregroundOverlay.test.ts`
Expected: PASS, 5 tests.

Then: `npm run typecheck`
Expected: no output.

Note `drawOverlay` and `combineWithMatte` are not unit-tested — jsdom has no canvas. Their correctness is checked in the browser at the end of Task 3. Do not add a canvas mock to manufacture coverage.

- [ ] **Step 5: Commit**

```bash
cd C:\Users\capoom\splat-viewer
git add src/foregroundOverlay.ts src/__tests__/foregroundOverlay.test.ts
git commit -m "feat: overlay fit maths, matte combining and the shared draw

fitInside scales up as well as down -- the plate is a framing reference, so a
small one still has to fill the frame. drawOverlay is the single draw the live
overlay and the capture composite both go through; if they ever compute
placement separately they will drift, and that agreement is the only reason
compositing happens in the viewer at all.

combineWithMatte folds node-banana's separate FG_alpha into the foreground's
alpha channel once, so both supply paths converge on one RGBA image.
destination-in is unusable here: it multiplies by the source's ALPHA and a
greyscale matte is fully opaque, so it would keep every pixel. Luminance is the
coverage, with the Rec.709 weights node-banana's lumToAlphaCanvas uses."
```

---

### Task 2: Overlay state, UI and the live view

**Files:**
- Modify: `C:\Users\capoom\splat-viewer\src\SplatViewer.tsx`

**Interfaces:**
- Consumes: `fitInside` from Task 1 (indirectly — the live overlay uses CSS `object-fit: contain`, which is the same placement).
- Produces: state `overlayImage: HTMLImageElement | null`, `overlayVisible: boolean`, `overlayOpacity: number`, and `loadOverlayFromUrl(url: string): Promise<void>` — Task 3 reads the state, Task 4 calls the loader.

- [ ] **Step 1: Add the state and the loader**

Near the other viewer state in `SplatViewer.tsx` (alongside `captureFlash` and friends):

```typescript
  // ─── Foreground overlay ────────────────────────────────────
  // A plate drawn over the live view for framing, and burned into captures.
  // Held as a decoded HTMLImageElement so the capture path can draw it
  // synchronously without another load.
  const [overlayImage, setOverlayImage] = useState<HTMLImageElement | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);

  const loadOverlayFromUrl = useCallback(async (url: string) => {
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("decode failed"));
        img.src = url;
      });
      setOverlayImage(img);
      setOverlayVisible(true);
    } catch (err) {
      // An overlay that will not decode must not take the capture down with it.
      console.warn("[overlay] could not load image:", err);
      setOverlayImage(null);
    }
  }, []);

  const clearOverlay = useCallback(() => setOverlayImage(null), []);
```

- [ ] **Step 2: Add the keyboard toggle**

In the existing keydown handler, beside the other single-key shortcuts (`F` fly/orbit, `T` timeline, `H` panels):

```typescript
      if (e.key === "o" || e.key === "O") {
        setOverlayVisible((v) => !v);
        return;
      }
```

- [ ] **Step 3: Draw the live overlay inside the framing box**

The framing overlay at `SplatViewer.tsx:4724` already computes the active crop box — `activeW`, `activeH`, `barLeft`, `barTop` — with the same fit-inside logic the capture uses. Put the plate in that exact box so the live view and the capture agree.

Inside that block's returned JSX, as a sibling of the mask div and BEFORE it (so the mask's bars draw over the plate):

```tsx
            {/* Foreground plate — same box the capture crops to, so what is
                framed here is what the composite produces. */}
            {overlayImage && overlayVisible && (
              <img
                src={overlayImage.src}
                alt=""
                draggable={false}
                className="absolute pointer-events-none select-none"
                style={{
                  left: insetLeft,
                  top: insetTop,
                  width: activeW,
                  height: activeH,
                  objectFit: "contain",
                  opacity: overlayOpacity,
                }}
              />
            )}
```

- [ ] **Step 4: Add the controls**

Beside the existing viewer controls, a load button, a clear button, and an opacity slider:

```tsx
        {/* Foreground overlay */}
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-neutral-400 w-[64px] shrink-0">Overlay</label>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            ref={overlayFileRef}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => void loadOverlayFromUrl(reader.result as string);
              reader.readAsDataURL(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => overlayFileRef.current?.click()}
            className="text-[10px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          >
            Load
          </button>
          {overlayImage && (
            <>
              <button
                onClick={() => setOverlayVisible((v) => !v)}
                title="Toggle overlay (O)"
                className="text-[10px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
              >
                {overlayVisible ? "Hide" : "Show"}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={overlayOpacity}
                onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                className="flex-1 min-w-0 accent-teal-500"
              />
              <button
                onClick={clearOverlay}
                className="text-[10px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
              >
                ✕
              </button>
            </>
          )}
        </div>
```

Declare the ref with the other refs:

```typescript
  const overlayFileRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 5: Accept a drag-dropped image**

The viewer already accepts dropped `.spz`/`.ply`/`.glb`/`.obj`. In that drop handler, before the model branches, route image types to the overlay:

```typescript
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => void loadOverlayFromUrl(reader.result as string);
        reader.readAsDataURL(file);
        return;
      }
```

- [ ] **Step 6: Verify in the browser**

Run: `cd C:\Users\capoom\splat-viewer && npm run dev`
Load a splat, drop a PNG on the window. Expected: the plate appears inside the framing box, `O` toggles it, the slider fades it, `✕` clears it. Change the aspect-ratio preset — the plate must stay inside the new box.

Then: `npm run typecheck` and `npm run test`
Expected: clean, and the Task 1 tests still pass.

- [ ] **Step 7: Commit**

```bash
cd C:\Users\capoom\splat-viewer
git add src/SplatViewer.tsx
git commit -m "feat: load a foreground plate and draw it over the live view

The plate is placed in the framing overlay's existing crop box -- the same box,
computed by the same fit-inside logic, that a capture crops to. Putting it
anywhere else would mean framing against one rectangle and capturing another.

Held as a decoded HTMLImageElement so the capture path can draw it without a
second load. An image that fails to decode clears the overlay and logs; it must
never take a capture down with it."
```

---

### Task 3: Composite the plate into captures

**Files:**
- Modify: `C:\Users\capoom\splat-viewer\src\SplatViewer.tsx` (capture path, ~`:3700-3775`)

**Interfaces:**
- Consumes: `drawOverlay` from Task 1; `overlayImage` / `overlayVisible` / `overlayOpacity` from Task 2.
- Produces: `compositeImage: string | null` on the `worldlabs-capture` postMessage payload. node-banana Task 7 reads it.

- [ ] **Step 1: Build the composite after the RGB canvas**

In the capture handler, immediately after `const image = offscreen.toDataURL("image/png");`:

```typescript
    // ─── 1b. Composite the foreground plate ───────────────────
    // Same draw and same fit as the live overlay, so the frame that was lined up
    // is the frame that comes out. Null when no plate is loaded, which keeps the
    // payload byte-identical to before this feature existed.
    let compositeImage: string | null = null;
    if (overlayImage && overlayVisible && overlayOpacity > 0) {
      const comp = document.createElement("canvas");
      comp.width = cropW;
      comp.height = cropH;
      const compCtx = comp.getContext("2d");
      if (compCtx) {
        compCtx.drawImage(offscreen, 0, 0);
        drawOverlay(compCtx, overlayImage, cropW, cropH, overlayOpacity);
        compositeImage = comp.toDataURL("image/png");
      }
    }
```

- [ ] **Step 2: Add it to the payload**

In the `window.opener.postMessage` call, add the field:

```typescript
          type: "worldlabs-capture",
          worldId,
          image,
          depthImage,
          compositeImage,
          filename,
          width: cropW,
          height: cropH,
```

- [ ] **Step 3: Download it in the standalone case**

In the `else` branch that downloads directly, after the existing raw download:

```typescript
      if (compositeImage) {
        const compLink = document.createElement("a");
        compLink.download = `${filename}_comp.png`;
        compLink.href = compositeImage;
        compLink.click();
      }
```

- [ ] **Step 4: Import the draw**

At the top of `SplatViewer.tsx`:

```typescript
import { drawOverlay, combineWithMatte } from "./foregroundOverlay";
```

(`combineWithMatte` is used in Task 4; importing both now avoids touching the import line twice.)

- [ ] **Step 5: Verify in the browser**

Run: `npm run dev`, load a splat, load a plate, set opacity ~0.5, capture.
Expected: two files download — `<name>.png` (clean) and `<name>_comp.png` (with the plate). **The plate must sit in exactly the position it occupied on screen.** Then clear the overlay and capture again: one file only.

Then: `npm run typecheck` and `npm run test`.

- [ ] **Step 6: Commit**

```bash
cd C:\Users\capoom\splat-viewer
git add src/SplatViewer.tsx
git commit -m "feat: burn the foreground plate into captures

The composite goes through the same drawOverlay and the same fit as the live
view, at the capture's cropped dimensions -- so the framing you set up is what
lands in the file.

Null when no plate is loaded, which keeps the capture payload byte-identical to
before this feature existed. Standalone captures download the clean frame and
the composite, mirroring the two nodes node-banana spawns."
```

---

### Task 4: Accept a plate from node-banana

**Files:**
- Modify: `C:\Users\capoom\splat-viewer\src\SplatViewer.tsx`

**Interfaces:**
- Consumes: `combineWithMatte` (Task 1), `loadOverlayFromUrl` (Task 2).
- Produces: reads `sessionStorage["splat-viewer-fg-<worldId>"]` shaped `{ fg: string; alpha: string | null }`, and accepts a `{ type: "splat-viewer-fg", worldId, fg, alpha }` message. node-banana Task 6 writes both.

- [ ] **Step 1: Read the handoff on load**

Beside the existing `sessionStorage.getItem("splat-viewer-state-" + wId)` read (~`:1272`):

```typescript
      // Foreground plate handed over by node-banana. Large images go through
      // sessionStorage rather than the URL, the same reason viewer state does.
      try {
        const fgRaw = sessionStorage.getItem(`splat-viewer-fg-${wId}`);
        if (fgRaw) {
          const { fg, alpha } = JSON.parse(fgRaw) as { fg: string; alpha: string | null };
          if (fg) void combineWithMatte(fg, alpha ?? null).then(loadOverlayFromUrl);
        }
      } catch (err) {
        console.warn("[overlay] could not read handoff:", err);
      }
```

- [ ] **Step 2: Listen for live updates**

The viewer has no inbound message listener at all today — it only posts outward. Add one:

```typescript
  // Inbound messages from the opener. The viewer previously only posted OUT;
  // this is the first thing it listens for, so the origin check matters.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const d = event.data;
      if (d?.type !== "splat-viewer-fg") return;
      if (worldId && d.worldId && d.worldId !== worldId) return;
      if (!d.fg) {
        setOverlayImage(null);
        return;
      }
      void combineWithMatte(d.fg, d.alpha ?? null).then(loadOverlayFromUrl);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [worldId, loadOverlayFromUrl]);
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` and `npm run test`. Expected: clean.

Browser check deferred to Part B Task 7, which is what produces the messages.

- [ ] **Step 4: Commit and deploy**

```bash
cd C:\Users\capoom\splat-viewer
git add src/SplatViewer.tsx
git commit -m "feat: accept a foreground plate from node-banana

Two entry points: a sessionStorage handoff read on load, for the plate that
exists when the viewer opens, and a splat-viewer-fg message for changes while it
is open. Both fold FG_alpha into the foreground once via combineWithMatte, so a
node-banana plate and a standalone one are the same thing internally.

This is the first message the viewer has ever listened FOR -- it only posted
outward before -- so the origin check is load-bearing rather than ceremonial."
git push origin main
```

Then deploy so node-banana can consume it: run `C:\caddy\deploy-splat-viewer.ps1` on OTOSERVE10. node-banana picks it up on next open, no rebuild.

---

# PART B — node-banana-capoom

### Task 5: Two input pins on the Splat Viewer node

**Files:**
- Modify: `C:\Users\capoom\node-banana-capoom\src\components\WorkflowCanvas.tsx:259`
- Modify: `C:\Users\capoom\node-banana-capoom\src\components\nodes\SpzViewerNode.tsx`
- Test: `C:\Users\capoom\node-banana-capoom\src\components\__tests__\SpzViewerNode.test.tsx` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: target handles `image-fg` and `image-fg_alpha` on `spzViewer`. Task 6 reads them.

- [ ] **Step 1: Write the failing test**

`src/components/__tests__/SpzViewerNode.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { getHandleType } from "@/components/WorkflowCanvas";

describe("spzViewer overlay pins", () => {
  it("types both new pins as image", () => {
    // getHandleType tests includes("image") BEFORE startsWith("text-"), so an id
    // containing "image" is an image pin. Both of these are meant to be.
    expect(getHandleType("image-fg")).toBe("image");
    expect(getHandleType("image-fg_alpha")).toBe("image");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\capoom\node-banana-capoom && npx vitest run src/components/__tests__/SpzViewerNode.test.tsx`
Expected: FAIL — `getHandleType` is not exported, or the assertion fails.

`getHandleType` is already exported (`WorkflowCanvas.tsx:178`, `export const`) and
`WorkflowCanvas.test.tsx` already imports it, so this assertion passes as soon as
the file exists. That is expected — it is a guard against a future rename, not a
driver. The failing part is Step 3's pin declaration, which nothing yet provides.

- [ ] **Step 3: Declare the pins**

`WorkflowCanvas.tsx:259`:

```typescript
    case "spzViewer":
      return { inputs: ["3d", "image-fg", "image-fg_alpha"], outputs: ["image"] };
```

- [ ] **Step 4: Render the handles**

In `SpzViewerNode.tsx`, beside the existing `3d` input handle (~`:435`):

```tsx
      {/* Foreground plate + its matte, handed to the viewer for framing and
          burned into captures. Optional: with neither wired the viewer behaves
          exactly as before. */}
      <Handle
        type="target"
        position={Position.Left}
        id="image-fg"
        data-handletype="image"
        style={{ top: "45%" }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="image-fg_alpha"
        data-handletype="image"
        style={{ top: "65%" }}
      />
```

Move the existing `3d` handle to `top: "25%"` so the three do not overlap.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/__tests__/SpzViewerNode.test.tsx && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
cd C:\Users\capoom\node-banana-capoom
git add src/components/WorkflowCanvas.tsx src/components/nodes/SpzViewerNode.tsx src/components/__tests__/SpzViewerNode.test.tsx
git commit -m "feat: FG and FG_alpha input pins on the splat viewer node

Both ids contain \"image\" so getHandleType classifies them as image pins --
that function tests includes(\"image\") before startsWith(\"text-\"), so the
naming is load-bearing rather than cosmetic, and a test pins it.

Optional: with neither wired the node and the viewer behave exactly as before."
```

---

### Task 6: Hand the plate to the viewer

**Files:**
- Modify: `C:\Users\capoom\node-banana-capoom\src\components\nodes\SpzViewerNode.tsx`
- Test: `C:\Users\capoom\node-banana-capoom\src\components\__tests__\SpzViewerNode.test.tsx`

**Interfaces:**
- Consumes: the pins from Task 5, resolved via `getConnectedInputs(id)`.
- Produces: `sessionStorage["splat-viewer-fg-<id>"]` = `{"fg": string, "alpha": string|null}` written before `window.open`; a `{type:"splat-viewer-fg", worldId, fg, alpha}` message posted to the open window on change. Consumed by Part A Task 4.

- [ ] **Step 1: Write the failing test**

Add to `src/components/__tests__/SpzViewerNode.test.tsx`:

```typescript
import { buildOverlayHandoff } from "@/components/nodes/SpzViewerNode";

describe("buildOverlayHandoff", () => {
  it("packs a foreground and its matte", () => {
    expect(buildOverlayHandoff(["data:image/png;base64,FG"], "data:image/png;base64,A"))
      .toEqual({ fg: "data:image/png;base64,FG", alpha: "data:image/png;base64,A" });
  });

  it("treats a foreground with no matte as opaque", () => {
    expect(buildOverlayHandoff(["data:image/png;base64,FG"], null))
      .toEqual({ fg: "data:image/png;base64,FG", alpha: null });
  });

  it("returns null when no foreground is wired, so a lone matte is ignored", () => {
    expect(buildOverlayHandoff([], "data:image/png;base64,A")).toBeNull();
    expect(buildOverlayHandoff([], null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SpzViewerNode.test.tsx`
Expected: FAIL — `buildOverlayHandoff` is not exported.

- [ ] **Step 3: Add the missing import**

`SpzViewerNode.tsx` resolves inputs through the store's `getConnectedInputs`, which
aggregates every image pin and cannot tell `image-fg` from `image-fg_alpha`. The
two pins have to be told apart by target handle, which needs the lower-level
resolver — the same one `CompNode.tsx:70-72` uses to separate its five pins:

```typescript
import { getSourceOutput } from "@/store/utils/connectedInputs";
```

- [ ] **Step 4: Implement**

In `SpzViewerNode.tsx`, at module scope:

```typescript
/**
 * Pack the FG pins into the payload the viewer expects.
 *
 * A matte with no foreground is meaningless, so it is dropped rather than sent
 * as a half-payload the viewer would have to defend against.
 */
export function buildOverlayHandoff(
  fgImages: string[],
  alphaImage: string | null,
): { fg: string; alpha: string | null } | null {
  const fg = fgImages[0];
  if (!fg) return null;
  return { fg, alpha: alphaImage ?? null };
}
```

- [ ] **Step 5: Resolve the pins and write the handoff**

In the component, resolve the two pins by target handle, mirroring how `dynamicInputs` are routed:

```typescript
  const overlayInputs = useWorkflowStore((s) => {
    const fg: string[] = [];
    let alpha: string | null = null;
    for (const e of s.edges) {
      if (e.target !== id) continue;
      const src = s.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
      if (out.type !== "image" || !out.value) continue;
      if (e.targetHandle === "image-fg") fg.push(out.value);
      else if (e.targetHandle === "image-fg_alpha") alpha = out.value;
    }
    return buildOverlayHandoff(fg, alpha);
  });
```

In `handleOpenViewer`, before `window.open`:

```typescript
    // Hand the plate over the same way viewer state travels: sessionStorage, not
    // the URL, because these are full-res data URLs.
    try {
      if (overlayInputs) {
        sessionStorage.setItem(`splat-viewer-fg-${id}`, JSON.stringify(overlayInputs));
      } else {
        sessionStorage.removeItem(`splat-viewer-fg-${id}`);
      }
    } catch (err) {
      console.warn("[spzViewer] could not write overlay handoff:", err);
    }
```

- [ ] **Step 6: Post live updates**

Keep a ref to the opened window (the existing `window.open` result), and:

```typescript
  // Push plate changes into an already-open viewer rather than making the user
  // reopen it.
  useEffect(() => {
    const w = viewerWindowRef.current;
    if (!w || w.closed) return;
    w.postMessage(
      { type: "splat-viewer-fg", worldId: id, fg: overlayInputs?.fg ?? null, alpha: overlayInputs?.alpha ?? null },
      window.location.origin,
    );
  }, [overlayInputs, id]);
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/components/__tests__/SpzViewerNode.test.tsx && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
cd C:\Users\capoom\node-banana-capoom
git add src/components/nodes/SpzViewerNode.tsx src/components/__tests__/SpzViewerNode.test.tsx
git commit -m "feat: hand the foreground plate to the splat viewer

sessionStorage before window.open, the same route viewer state already takes,
because these are full-res data URLs and the URL is not a place for them. A
postMessage pushes later changes into an already-open viewer rather than making
the user reopen it.

A matte with no foreground is dropped rather than sent as a half-payload the
viewer would have to defend against."
```

---

### Task 7: Spawn a node from the returned composite

**Files:**
- Modify: `C:\Users\capoom\node-banana-capoom\src\components\nodes\SpzViewerNode.tsx` (capture handler)
- Test: `C:\Users\capoom\node-banana-capoom\src\components\__tests__\SpzViewerNode.test.tsx`

**Interfaces:**
- Consumes: `compositeImage` on the capture payload (Part A Task 3).
- Produces: an additional `imageInput` node named `<filename>_comp.png`, saved to `inputs/`.

- [ ] **Step 1: Write the failing test**

```typescript
import { capturedImageCount } from "@/components/nodes/SpzViewerNode";

describe("capture node spawning", () => {
  it("spawns one node per returned image", () => {
    expect(capturedImageCount({ image: "i", depthImage: null, compositeImage: null })).toBe(1);
    expect(capturedImageCount({ image: "i", depthImage: "d", compositeImage: null })).toBe(2);
    expect(capturedImageCount({ image: "i", depthImage: "d", compositeImage: "c" })).toBe(3);
    expect(capturedImageCount({ image: "i", depthImage: null, compositeImage: "c" })).toBe(2);
  });

  it("counts nothing for a capture with no image", () => {
    expect(capturedImageCount({ image: null, depthImage: null, compositeImage: null })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SpzViewerNode.test.tsx`
Expected: FAIL — `capturedImageCount` is not exported.

- [ ] **Step 3: Implement the counter**

At module scope in `SpzViewerNode.tsx`:

```typescript
/**
 * How many imageInput nodes one capture produces.
 *
 * The vertical offset between successive captures is derived from this, so it
 * has to agree with what the handler actually spawns.
 */
export function capturedImageCount(payload: {
  image: string | null;
  depthImage: string | null;
  compositeImage: string | null;
}): number {
  if (!payload.image) return 0;
  return 1 + (payload.depthImage ? 1 : 0) + (payload.compositeImage ? 1 : 0);
}
```

- [ ] **Step 4: Spawn the composite node**

In the capture handler, destructure the new field:

```typescript
      const { image, depthImage, compositeImage, filename, width, height } = event.data;
```

Replace the hardcoded `nodesPerCapture`:

```typescript
      const nodesPerCapture = capturedImageCount({ image, depthImage, compositeImage });
```

And after the depth node block, spawn the composite the same way:

```typescript
        // Composite (splat render with the foreground plate burned in)
        if (compositeImage) {
          addNode("imageInput", {
            x: nodeX + offsetX,
            y: nodeY + baseOffsetY + (depthImage ? 2 : 1) * (imgNodeHeight + 20),
          });

          setTimeout(async () => {
            const compNodes = useWorkflowStore.getState().nodes;
            const compNode = compNodes[compNodes.length - 1];

            let compRef: string | undefined;
            if (saveDirectoryPath) {
              const refId = await saveMediaImmediately(compositeImage, saveDirectoryPath, "inputs");
              if (refId) compRef = refId;
            }

            if (compNode && compNode.type === "imageInput") {
              updateNodeData(compNode.id, {
                image: compositeImage,
                imageRef: compRef,
                filename: `${filename}_comp.png`,
                dimensions: width && height ? { width, height } : null,
              });
            }
          }, 100);
        }
```

The `100`ms delay is longer than the depth node's `50` so the two `addNode` calls do not race for `nodes[nodes.length - 1]`.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Verify end to end in the browser**

1. Restart the dev server: `npm run dev`
2. Wire an image into `image-fg` and a matte into `image-fg_alpha` on a Splat Viewer node.
3. Open the viewer. Expected: the plate appears over the 3D view, matted.
4. Change the upstream image while the viewer is open. Expected: the plate updates without reopening.
5. Capture. Expected: three `imageInput` nodes — clean, depth (if enabled), composite — and the composite's plate sits exactly where it was on screen.
6. Disconnect both pins and capture again. Expected: one node, no composite.

- [ ] **Step 7: Commit**

```bash
cd C:\Users\capoom\node-banana-capoom
git add src/components/nodes/SpzViewerNode.tsx src/components/__tests__/SpzViewerNode.test.tsx
git commit -m "feat: spawn a node from the viewer's composited capture

Follows the path captures already take out of this node -- spawning imageInput
nodes and saving to inputs/ -- rather than the `image` output pin, which has
never carried anything (capturedImage is only ever assigned null). Repairing
that pin is a separate change with its own blast radius.

capturedImageCount is shared between the spawn logic and the vertical offset
between successive captures, so the two cannot disagree about how many nodes a
capture produces."
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Overlay is a viewer feature, two supply paths | 1, 2, 4 |
| One RGBA image internally, combined once | 1 (`combineWithMatte`), 4 |
| Compositing in the viewer | 3 |
| Same code draws overlay and composite | 1 (`drawOverlay`), 2, 3 |
| Fit inside, centred | 1 (`fitInside`), 2, 3 |
| Overlay not persisted to viewer state | 2 — held in React state only, never written to `localStorage` |
| Standalone load, toggle `O`, opacity | 2 |
| sessionStorage handoff + live message | 4, 6 |
| New inbound listener | 4 |
| `compositeImage` on the payload | 3 |
| Third `imageInput` node | 7 |
| Two input pins | 5 |
| Degenerate cases | 1 (zero dims), 2 (decode failure), 6 (lone matte), 7 (no composite) |
| Ship viewer first | Part A precedes Part B; Task 4 deploys |

**Type consistency:** `fitInside` / `drawOverlay` / `combineWithMatte` are named identically in Tasks 1–4. The handoff shape `{ fg, alpha }` is written in Task 6 and read in Task 4. `compositeImage` is the field name in Tasks 3 and 7. `capturedImageCount` is defined and used in Task 7 only.

**Known gap, deliberate:** `drawOverlay` and `combineWithMatte` have no unit tests — jsdom has no canvas in either repo. They are verified in the browser in Tasks 3 and 7. Adding a canvas mock would produce coverage that proves nothing about pixels.
