/**
 * renderSphereLight — renders a grey matte sphere lit by a single light from a
 * configurable direction (azimuth + elevation) at a given intensity, on a
 * neutral backdrop with a soft cast shadow, and returns a PNG data URL.
 *
 * Primary path (renderSphereLightGL): a SINGLE shared/pooled Three.js renderer
 * (one WebGL context for every node instance + every Run — never per-node, so
 * the browser's GL-context limit can't be exhausted). Single-pass, direct to
 * the canvas: a matte sphere + an unlit background plane + a ShadowMaterial
 * shadow-catcher, lit by one directional light. Soft shadows come from VSM
 * shadow maps (shadow.radius) — no global shadow-shader patch, so the other
 * viewers (glbViewer/spzViewer) are untouched.
 *
 * Fallback (renderSphereLight2D): pure 2D-canvas Lambert sphere + soft gradient
 * shadow, used if WebGL is unavailable or the GL path throws.
 */

import * as THREE from "three";

export interface SphereLightParams {
  rotation: number;  // light azimuth, degrees
  elevation: number; // light elevation, degrees
  intensity: number; // diffuse strength, ~0..10
}

// Light direction (unit vector), built as "rotate azimuth around the vertical
// axis, THEN elevate": azimuth spins the light horizontally around the sphere
// (L.y is independent of rotation, so rotating never lifts it), elevation tilts
// it up/down. Screen convention: +x right, +y up, +z toward the viewer;
// azimuth=0 → light from the front, positive elevation → from above.
function lightDirection({ rotation, elevation }: SphereLightParams): THREE.Vector3 {
  const az = (rotation * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return new THREE.Vector3(Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl).normalize();
}

// ───────────────────────── GL (pooled, single-pass) path ─────────────────────────

// Greys defined as sRGB hex (Three converts to linear internally, so the
// displayed colour matches the hex).
const BG_HEX = 0x6e6e6e;        // backdrop
const SPHERE_HEX = 0xcccccc;    // sphere albedo
const AMBIENT = 0.4;            // fill light (keeps the dark side from going black)
const SHADOW_OPACITY = 0.55;    // cast-shadow darkness (independent of light intensity)
const H = 2.15;                 // ortho half-frame (sphere radius 1 → ~46% of frame)

interface Pool {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  key: THREE.DirectionalLight;
  size: number;
}

let pool: Pool | null = null;

function getPool(size: number): Pool {
  if (pool && pool.size === size) return pool;
  if (pool) {
    pool.renderer.setSize(size, size, false);
    pool.size = size;
    return pool;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  renderer.setClearColor(BG_HEX, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.OrthographicCamera(-H, H, H, -H, 0.1, 100);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshStandardMaterial({ color: SPHERE_HEX, roughness: 1, metalness: 0 }),
  );
  sphere.castShadow = true;
  scene.add(sphere);

  // Unlit background plane — constant grey, unaffected by the key light (stable
  // backdrop regardless of light direction/intensity).
  const bgPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 6, H * 6),
    new THREE.MeshBasicMaterial({ color: BG_HEX }),
  );
  bgPlane.position.set(0, 0, -2);
  scene.add(bgPlane);

  // Shadow catcher — a transparent plane just behind the sphere showing ONLY the
  // cast shadow; darkness set by opacity, not by how much the key lights it, so
  // the backdrop can't blow out.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 6, H * 6),
    new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY }),
  );
  shadowCatcher.position.set(0, 0, -1.01);
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));

  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 8;         // VSM blur → soft penumbra
  key.shadow.blurSamples = 24;
  key.shadow.bias = -0.0005;
  const c = key.shadow.camera;
  c.near = 0.5;
  c.far = 30;
  c.left = -3;
  c.right = 3;
  c.top = 3;
  c.bottom = -3;
  scene.add(key);
  scene.add(key.target);

  pool = { renderer, scene, camera, key, size };
  return pool;
}

function renderSphereLightGL(params: SphereLightParams, size: number): string {
  const p = getPool(size);
  const L = lightDirection(params);
  p.key.position.copy(L).multiplyScalar(8);
  p.key.target.position.set(0, 0, 0);
  p.key.target.updateMatrixWorld();
  p.key.intensity = Math.max(0, params.intensity);
  p.renderer.setRenderTarget(null);
  p.renderer.render(p.scene, p.camera);
  return p.renderer.domElement.toDataURL("image/png");
}

// ───────────────────────── 2D fallback ─────────────────────────

function renderSphereLight2D(params: SphereLightParams, size: number): string {
  const { intensity } = params;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const L = lightDirection(params);
  const bgV = (0.45 * 255) | 0;
  ctx.fillStyle = `rgb(${bgV},${bgV},${bgV})`;
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.28;

  const elFactor = Math.max(0.15, Math.abs(L.y));
  const shadowLen = R * (1.5 + (1 - elFactor) * 2.4);
  const shV = (0.11 * 255) | 0;
  ctx.save();
  ctx.translate(cx + -L.x * R * 1.15, cy + R * 0.45);
  ctx.scale(1, 0.42);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, shadowLen);
  grad.addColorStop(0, `rgba(${shV},${shV},${shV},0.85)`);
  grad.addColorStop(0.6, `rgba(${shV},${shV},${shV},0.4)`);
  grad.addColorStop(1, `rgba(${shV},${shV},${shV},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, shadowLen, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const ambient = 0.12;
  const kd = 0.28;
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const R2 = R * R;
  for (let py = Math.max(0, (cy - R) | 0); py < Math.min(size, Math.ceil(cy + R)); py++) {
    for (let px = Math.max(0, (cx - R) | 0); px < Math.min(size, Math.ceil(cx + R)); px++) {
      const dx = px - cx;
      const dy = py - cy;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > R2) continue;
      const nx = dx / R;
      const ny = -dy / R;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const ndotl = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
      let b = ambient + kd * intensity * ndotl;
      if (b > 1) b = 1;
      const v = (b * 255) | 0;
      const idx = (py * size + px) * 4;
      const a = Math.min(1, Math.max(0, R - Math.sqrt(dist2)));
      d[idx] = v * a + d[idx] * (1 - a);
      d[idx + 1] = v * a + d[idx + 1] * (1 - a);
      d[idx + 2] = v * a + d[idx + 2] * (1 - a);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// ───────────────────────── entry ─────────────────────────

export function renderSphereLight(params: SphereLightParams, size = 512): string {
  if (typeof document === "undefined") return ""; // SSR / non-browser guard
  try {
    return renderSphereLightGL(params, size);
  } catch (err) {
    console.warn("[renderSphereLight] GL path failed, falling back to 2D:", err);
    try {
      return renderSphereLight2D(params, size);
    } catch (err2) {
      console.error("[renderSphereLight] 2D fallback also failed:", err2);
      return "";
    }
  }
}
