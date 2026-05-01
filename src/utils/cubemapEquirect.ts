/**
 * Cubemap-cross ⇄ equirectangular projection on the 2D canvas.
 *
 * The math mirrors the Houdini render pipeline this app integrates with:
 *
 *   theta = (u/W) * 2π     (longitude, 0 → 2π left to right)
 *   phi   = (v/H) * π      (latitude, 0 → π top to bottom)
 *   dx = sin(phi) * sin(theta)
 *   dy = cos(phi)          (Y up)
 *   dz = sin(phi) * cos(theta)
 *
 * Face is chosen by the largest absolute axis. The cubemap-cross layout
 * places faces at these (col, row) cells in a 4-wide × 3-tall grid:
 *
 *      [   ][ U ][   ][   ]
 *      [ R ][ F ][ L ][ B ]
 *      [   ][ D ][   ][   ]
 *
 *   up:    col=1 row=0
 *   right: col=0 row=1
 *   front: col=1 row=1
 *   left:  col=2 row=1
 *   back:  col=3 row=1
 *   down:  col=1 row=2
 *
 * Sampling is nearest-neighbour for parity with the Houdini reference; that
 * keeps round-trips deterministic and avoids softening edge details.
 */

type Face = "up" | "right" | "front" | "left" | "back" | "down";

const CROSS_POS: Record<Face, [number, number]> = {
  up: [1, 0],
  right: [0, 1],
  front: [1, 1],
  left: [2, 1],
  back: [3, 1],
  down: [1, 2],
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load source image"));
    img.src = src;
  });
}

function readImageData(img: HTMLImageElement): { data: Uint8ClampedArray; w: number; h: number } {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context");
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  return { data: id.data, w: img.width, h: img.height };
}

function writeOutputAsDataUrl(
  data: Uint8ClampedArray,
  width: number,
  height: number
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context");
  const id = ctx.createImageData(width, height);
  id.data.set(data);
  ctx.putImageData(id, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Convert a cubemap-cross image (4N × 3N) into a 2:1 equirectangular pano.
 * `outputWidth` controls the equirect width; height is half.
 */
export async function cubemapToEquirect(
  src: string,
  outputWidth: number
): Promise<string> {
  const img = await loadImage(src);
  const source = readImageData(img);

  // Both dimensions should agree on the face size (4× wide × 3× tall). Use
  // the smaller floor to stay safely inside the source bounds.
  const faceSize = Math.min(Math.floor(source.w / 4), Math.floor(source.h / 3));
  if (faceSize <= 0) throw new Error("Source must be a 4:3 cubemap-cross");

  const outW = Math.max(2, Math.floor(outputWidth));
  const outH = Math.max(1, Math.floor(outW / 2));
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let v = 0; v < outH; v++) {
    const phi = ((v + 0.5) / outH) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let u = 0; u < outW; u++) {
      const theta = ((u + 0.5) / outW) * 2 * Math.PI;
      const dx = sinPhi * Math.sin(theta);
      const dy = cosPhi;
      const dz = sinPhi * Math.cos(theta);

      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      const mx = Math.max(ax, ay, az);

      let face: Face;
      let fu: number;
      let fv: number;

      if (ax >= mx - 1e-8) {
        if (dx <= 0) {
          face = "front";
          fu = (-dz / ax + 1) / 2;
          fv = (1 - dy / ax) / 2;
        } else {
          face = "back";
          fu = (dz / ax + 1) / 2;
          fv = (1 - dy / ax) / 2;
        }
      } else if (az >= mx - 1e-8) {
        if (dz <= 0) {
          face = "left";
          fu = (dx / az + 1) / 2;
          fv = (1 - dy / az) / 2;
        } else {
          face = "right";
          fu = (-dx / az + 1) / 2;
          fv = (1 - dy / az) / 2;
        }
      } else if (dy > 0) {
        face = "up";
        fu = (1 - dz / ay) / 2;
        fv = (1 - dx / ay) / 2;
      } else {
        face = "down";
        fu = (1 - dz / ay) / 2;
        fv = (dx / ay + 1) / 2;
      }

      // Clamp fractional uv into [0, 1]
      fu = fu < 0 ? 0 : fu > 1 ? 1 : fu;
      fv = fv < 0 ? 0 : fv > 1 ? 1 : fv;

      const [col, row] = CROSS_POS[face];
      const sx = col * faceSize + Math.min(faceSize - 1, Math.floor(fu * faceSize));
      const sy = row * faceSize + Math.min(faceSize - 1, Math.floor(fv * faceSize));

      const si = (sy * source.w + sx) * 4;
      const oi = (v * outW + u) * 4;
      out[oi] = source.data[si];
      out[oi + 1] = source.data[si + 1];
      out[oi + 2] = source.data[si + 2];
      out[oi + 3] = 255;
    }
  }

  return writeOutputAsDataUrl(out, outW, outH);
}

/**
 * Convert a 2:1 equirectangular pano into a cubemap cross of size
 * (4 × faceSize) × (3 × faceSize). Empty cells in the cross stay black.
 */
export async function equirectToCubemap(
  src: string,
  faceSize: number
): Promise<string> {
  const img = await loadImage(src);
  const source = readImageData(img);

  const fs = Math.max(1, Math.floor(faceSize));
  const outW = fs * 4;
  const outH = fs * 3;
  const out = new Uint8ClampedArray(outW * outH * 4);

  // Pre-fill alpha so empty quadrants are opaque black instead of transparent.
  for (let i = 3; i < out.length; i += 4) out[i] = 255;

  // For each face cell, walk its faceSize × faceSize pixels, derive the
  // direction vector, convert to (theta, phi), and sample the equirect.
  (Object.keys(CROSS_POS) as Face[]).forEach((face) => {
    const [col, row] = CROSS_POS[face];

    for (let py = 0; py < fs; py++) {
      const fv = (py + 0.5) / fs;
      for (let px = 0; px < fs; px++) {
        const fu = (px + 0.5) / fs;

        // Inverse of the cube-to-equi mapping per face.
        let dx: number;
        let dy: number;
        let dz: number;
        switch (face) {
          case "front": // dx = -1
            dx = -1;
            dy = 1 - 2 * fv;
            dz = 1 - 2 * fu;
            break;
          case "back": // dx = +1
            dx = 1;
            dy = 1 - 2 * fv;
            dz = 2 * fu - 1;
            break;
          case "left": // dz = -1
            dx = 2 * fu - 1;
            dy = 1 - 2 * fv;
            dz = -1;
            break;
          case "right": // dz = +1
            dx = 1 - 2 * fu;
            dy = 1 - 2 * fv;
            dz = 1;
            break;
          case "up": // dy = +1
            dx = 1 - 2 * fv;
            dy = 1;
            dz = 1 - 2 * fu;
            break;
          case "down": // dy = -1
          default:
            dx = 2 * fv - 1;
            dy = -1;
            dz = 1 - 2 * fu;
            break;
        }

        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const nx = dx / len;
        const ny = dy / len;
        const nz = dz / len;

        let theta = Math.atan2(nx, nz);
        if (theta < 0) theta += 2 * Math.PI;
        const phi = Math.acos(ny < -1 ? -1 : ny > 1 ? 1 : ny);

        const eqU = (theta / (2 * Math.PI)) * source.w;
        const eqV = (phi / Math.PI) * source.h;
        const sx = Math.max(0, Math.min(source.w - 1, Math.floor(eqU)));
        const sy = Math.max(0, Math.min(source.h - 1, Math.floor(eqV)));

        const si = (sy * source.w + sx) * 4;
        const ox = col * fs + px;
        const oy = row * fs + py;
        const oi = (oy * outW + ox) * 4;
        out[oi] = source.data[si];
        out[oi + 1] = source.data[si + 1];
        out[oi + 2] = source.data[si + 2];
        out[oi + 3] = 255;
      }
    }
  });

  return writeOutputAsDataUrl(out, outW, outH);
}

export type CubemapEquirectMode = "cubeToEquirect" | "equirectToCube";

/**
 * Generic dispatcher used by both the live node component and the workflow
 * executor.
 */
export async function applyCubemapEquirect(
  src: string,
  mode: CubemapEquirectMode,
  outputSize: number
): Promise<string> {
  if (mode === "cubeToEquirect") return cubemapToEquirect(src, outputSize);
  return equirectToCubemap(src, outputSize);
}
