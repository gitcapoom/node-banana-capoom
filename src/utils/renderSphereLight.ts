/**
 * renderSphereLight — draws a grey matte sphere lit by a single light from a
 * configurable direction (azimuth + elevation) at a given intensity, on a
 * neutral backdrop with a soft cast shadow, and returns a PNG data URL.
 *
 * Pure 2D canvas (no WebGL) so many instances can't exhaust GL contexts and it
 * works both in the node preview and the Run executor. The sphere uses exact
 * orthographic Lambert shading (N·L); the shadow is a squashed, softened
 * radial gradient offset opposite the light.
 */

export interface SphereLightParams {
  rotation: number;  // light azimuth, degrees
  elevation: number; // light elevation, degrees
  intensity: number; // diffuse strength, ~0..10
}

export function renderSphereLight(params: SphereLightParams, size = 512): string {
  if (typeof document === "undefined") return ""; // SSR / non-browser guard

  const { rotation, elevation, intensity } = params;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Light direction (unit vector). Screen convention: +x right, +y up, +z toward
  // the viewer. azimuth=0 → light from the front; positive elevation raises it.
  const az = (rotation * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const cosEl = Math.cos(el);
  const Lx = Math.sin(az) * cosEl;
  const Ly = Math.sin(el);
  const Lz = Math.cos(az) * cosEl;

  // Neutral backdrop.
  const bg = 0.45;
  const bgV = (bg * 255) | 0;
  ctx.fillStyle = `rgb(${bgV},${bgV},${bgV})`;
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.28;

  // ── Cast shadow (drawn behind the sphere) ──
  // Offset opposite the light's screen-horizontal; longer and flatter as the
  // light gets lower (small |Ly|).
  const elFactor = Math.max(0.15, Math.abs(Ly));
  const shadowLen = R * (1.5 + (1 - elFactor) * 2.4);
  const shadowCx = cx + -Lx * R * 1.15;
  const shadowCy = cy + R * 0.45;
  const shDark = Math.max(0.1, bg - 0.34);
  const shV = (shDark * 255) | 0;
  ctx.save();
  ctx.translate(shadowCx, shadowCy);
  ctx.scale(1, 0.42); // ground-plane squash
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, shadowLen);
  grad.addColorStop(0, `rgba(${shV},${shV},${shV},0.85)`);
  grad.addColorStop(0.6, `rgba(${shV},${shV},${shV},0.4)`);
  grad.addColorStop(1, `rgba(${shV},${shV},${shV},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, shadowLen, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Sphere (per-pixel Lambert over the current buffer, so the edge blends
  //    over the backdrop/shadow) ──
  const ambient = 0.12;
  const kd = 0.28; // diffuse gain per unit intensity
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const R2 = R * R;
  const yMin = Math.max(0, Math.floor(cy - R));
  const yMax = Math.min(size, Math.ceil(cy + R));
  const xMin = Math.max(0, Math.floor(cx - R));
  const xMax = Math.min(size, Math.ceil(cx + R));
  for (let py = yMin; py < yMax; py++) {
    for (let px = xMin; px < xMax; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > R2) continue;
      const nx = dx / R;
      const ny = -dy / R;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const ndotl = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      let b = ambient + kd * intensity * ndotl;
      if (b > 1) b = 1;
      const v = (b * 255) | 0;
      const idx = (py * size + px) * 4;
      const edge = R - Math.sqrt(dist2); // px inside the rim
      const a = edge >= 1 ? 1 : Math.max(0, edge);
      if (a >= 1) {
        d[idx] = v;
        d[idx + 1] = v;
        d[idx + 2] = v;
        d[idx + 3] = 255;
      } else {
        d[idx] = v * a + d[idx] * (1 - a);
        d[idx + 1] = v * a + d[idx + 1] * (1 - a);
        d[idx + 2] = v * a + d[idx + 2] * (1 - a);
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  return canvas.toDataURL("image/png");
}
