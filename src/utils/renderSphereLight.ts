/**
 * renderSphereLight — renders a grey matte sphere lit by a single light from a
 * configurable direction (azimuth + elevation) at a given intensity, on a
 * neutral backdrop with a physically-plausible cast shadow, and returns a PNG
 * data URL.
 *
 * Primary path (renderSphereLightGL): a SINGLE shared/pooled Three.js renderer
 * (one WebGL context for every node instance + every Run — never per-node, so
 * the browser's GL-context limit can't be exhausted). Contact-hardening soft
 * shadows come from AREA-LIGHT sampling: the scene is rendered N times with the
 * light jittered within a small angular cone and the results averaged. That
 * yields a penumbra that is sharp at the contact and widens with distance —
 * real contact hardening — without patching Three's global shadow shader (so
 * the other viewers are untouched). Averaging is done on the GPU in linear
 * space via two render targets + an additive weighted copy.
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

// Light direction (unit vector). Screen convention: +x right, +y up, +z toward
// the viewer. azimuth=0 → light from the front; positive elevation raises it.
function lightDirection({ rotation, elevation }: SphereLightParams): THREE.Vector3 {
  const az = (rotation * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return new THREE.Vector3(Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl).normalize();
}

// ───────────────────────── GL (pooled) path ─────────────────────────

const N_SAMPLES = 16;          // area-light samples averaged per render
const CONE_HALF_ANGLE = 0.075; // radians (~4.3°) — light angular radius → penumbra size

// Deterministic Vogel-spiral disk samples in [-1,1]² (stable across renders → no flicker).
const DISK_SAMPLES: Array<[number, number]> = (() => {
  const pts: Array<[number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N_SAMPLES; i++) {
    const r = Math.sqrt((i + 0.5) / N_SAMPLES);
    const a = i * golden;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
})();

interface Pool {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  sphere: THREE.Mesh;
  bgPlane: THREE.Mesh;
  shadowCatcher: THREE.Mesh;
  key: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  tempRT: THREE.WebGLRenderTarget;
  accumRT: THREE.WebGLRenderTarget;
  quadScene: THREE.Scene;
  quadCam: THREE.OrthographicCamera;
  quad: THREE.Mesh;
  accumMat: THREE.ShaderMaterial;
  copyMat: THREE.MeshBasicMaterial;
  size: number;
}

let pool: Pool | null = null;

const BG_GREY = 0.62;      // backdrop albedo
const SPHERE_GREY = 0.9;   // sphere albedo
const H = 2.15;            // ortho half-frame (sphere radius 1 → ~46% of frame)

function makeRT(size: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  return rt;
}

function getPool(size: number): Pool {
  if (pool && pool.size === size) return pool;

  if (pool) {
    // size changed — just resize renderer + targets
    pool.renderer.setSize(size, size, false);
    pool.tempRT.dispose();
    pool.accumRT.dispose();
    pool.tempRT = makeRT(size);
    pool.accumRT = makeRT(size);
    pool.size = size;
    return pool;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.OrthographicCamera(-H, H, H, -H, 0.1, 100);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(SPHERE_GREY, SPHERE_GREY, SPHERE_GREY) }),
  );
  sphere.castShadow = true;
  sphere.receiveShadow = false;
  scene.add(sphere);

  // Unlit background plane (constant grey, unaffected by the key) — gives a
  // stable backdrop independent of light direction/intensity.
  const bgPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 6, H * 6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(BG_GREY, BG_GREY, BG_GREY) }),
  );
  bgPlane.position.set(0, 0, -2);
  scene.add(bgPlane);

  // Shadow catcher: a transparent plane just behind the sphere that shows ONLY
  // the cast shadow (darkens the bg where shadowed). Its darkness is set by
  // opacity, NOT by how much the key lights it — so the backdrop can't blow out.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 6, H * 6),
    new THREE.ShadowMaterial({ opacity: 0.5 }),
  );
  shadowCatcher.position.set(0, 0, -1.02);
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  const s = 2.6;
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0006;
  scene.add(key);
  scene.add(key.target);

  // Fullscreen-quad plumbing for the weighted-average accumulation.
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const accumMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uWeight: { value: 1 / N_SAMPLES } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uWeight; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv) * uWeight; }`,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const copyMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), accumMat);
  quadScene.add(quad);

  pool = {
    renderer, scene, camera, sphere, bgPlane, shadowCatcher, key, ambient,
    tempRT: makeRT(size), accumRT: makeRT(size),
    quadScene, quadCam, quad, accumMat, copyMat, size,
  };
  return pool;
}

function renderSphereLightGL(params: SphereLightParams, size: number): string {
  const p = getPool(size);
  const { renderer, scene, camera, key, quadScene, quadCam, quad, accumMat, copyMat, tempRT, accumRT } = p;

  const L = lightDirection(params);
  const dist = 8;
  key.intensity = Math.max(0, params.intensity);

  // Orthonormal frame perpendicular to L for cone jitter.
  const up = Math.abs(L.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3().crossVectors(up, L).normalize();
  const bitangent = new THREE.Vector3().crossVectors(L, tangent).normalize();
  const tanCone = Math.tan(CONE_HALF_ANGLE);

  renderer.autoClear = true;
  const prevTarget = renderer.getRenderTarget();

  for (let i = 0; i < N_SAMPLES; i++) {
    const [dx, dy] = DISK_SAMPLES[i];
    const dir = L.clone()
      .addScaledVector(tangent, dx * tanCone)
      .addScaledVector(bitangent, dy * tanCone)
      .normalize();
    key.position.copy(dir).multiplyScalar(dist);
    key.target.position.set(0, 0, 0);
    key.target.updateMatrixWorld();

    // Render the lit scene (with its hard-ish shadow) into tempRT…
    renderer.setRenderTarget(tempRT);
    renderer.autoClear = true;
    renderer.render(scene, camera);

    // …then add tempRT * (1/N) into accumRT (clear accumRT on the first pass).
    accumMat.uniforms.tDiffuse.value = tempRT.texture;
    quad.material = accumMat;
    renderer.setRenderTarget(accumRT);
    renderer.autoClear = i === 0;
    renderer.render(quadScene, quadCam);
  }

  // Composite the averaged result to the canvas (gets sRGB output encoding).
  copyMat.map = accumRT.texture;
  copyMat.needsUpdate = true;
  quad.material = copyMat;
  renderer.setRenderTarget(null);
  renderer.autoClear = true;
  renderer.render(quadScene, quadCam);

  renderer.setRenderTarget(prevTarget);
  return renderer.domElement.toDataURL("image/png");
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
