/**
 * Forward Brown-Conrady (OpenCV) lens distortion as a Three.js post-pass.
 *
 * Used by the SPZ viewer to render Gaussian splats as if shot through a real
 * lens — so the result composites cleanly with live-action plates that share
 * the same intrinsics. Parameters match COLMAP's `OPENCV` model:
 *   fx, fy, cx, cy   — focal length + principal point in pixels
 *   k1, k2           — radial distortion coefficients
 *   p1, p2           — tangential distortion coefficients
 *
 * ## Why inverse mapping
 * For each output pixel (the distorted image we want to see), we need to
 * find the source pinhole pixel that the lens would have bent to that spot.
 * Brown-Conrady has no closed-form inverse, but Newton iteration on the
 * forward map converges quickly: 5 iterations gives sub-pixel accuracy for
 * normal cinema lenses (k1 ≲ 0.5).
 *
 * ## Coverage
 * The shader assumes the source render covers a slightly wider FOV than the
 * distorted output — otherwise edges get "no source" gaps. The viewer
 * compensates by rendering at a small FOV margin (computed from the
 * distortion magnitude).
 */

import * as THREE from "three";

export interface DistortionUniforms {
  tDiffuse: THREE.IUniform<THREE.Texture | null>;
  resolution: THREE.IUniform<THREE.Vector2>;
  fx: THREE.IUniform<number>;
  fy: THREE.IUniform<number>;
  cx: THREE.IUniform<number>;
  cy: THREE.IUniform<number>;
  k1: THREE.IUniform<number>;
  k2: THREE.IUniform<number>;
  p1: THREE.IUniform<number>;
  p2: THREE.IUniform<number>;
  enabled: THREE.IUniform<number>;
}

export const DISTORTION_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export const DISTORTION_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 resolution;
  uniform float fx;
  uniform float fy;
  uniform float cx;
  uniform float cy;
  uniform float k1;
  uniform float k2;
  uniform float p1;
  uniform float p2;
  uniform float enabled;

  varying vec2 vUv;

  void main() {
    if (enabled < 0.5) {
      gl_FragColor = texture2D(tDiffuse, vUv);
      return;
    }

    // Output pixel position (distorted image space).
    vec2 pxOut = vUv * resolution;

    // Convert to normalised distorted coordinates (pinhole-relative).
    float ud = (pxOut.x - cx) / fx;
    float vd = (pxOut.y - cy) / fy;

    // Newton iteration to invert Brown-Conrady. Starts from the distorted
    // coords as the seed; converges to the corresponding undistorted coords.
    float un = ud;
    float vn = vd;
    for (int i = 0; i < 5; i++) {
      float r2 = un * un + vn * vn;
      float radial = 1.0 + k1 * r2 + k2 * r2 * r2;
      float dx = 2.0 * p1 * un * vn + p2 * (r2 + 2.0 * un * un);
      float dy = p1 * (r2 + 2.0 * vn * vn) + 2.0 * p2 * un * vn;
      // Avoid divide-by-zero in degenerate cases.
      float safe = max(radial, 1e-4);
      un = (ud - dx) / safe;
      vn = (vd - dy) / safe;
    }

    // Back to pixel coords in the (undistorted) source render.
    vec2 pxIn = vec2(un * fx + cx, vn * fy + cy);
    vec2 uvIn = pxIn / resolution;

    // Out-of-bounds → opaque black so the framing edge is unambiguous.
    if (uvIn.x < 0.0 || uvIn.x > 1.0 || uvIn.y < 0.0 || uvIn.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    gl_FragColor = texture2D(tDiffuse, uvIn);
  }
`;

/**
 * Build a fullscreen-quad mesh + camera + scene wired up to the distortion
 * shader. The caller renders the scene's source target into `uniforms.tDiffuse`,
 * sets the params, and then renders this mini-scene to whatever final target
 * (screen or another RT for export).
 */
export function createDistortionPass(): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: DistortionUniforms;
  dispose: () => void;
} {
  const uniforms: DistortionUniforms = {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    fx: { value: 1000 },
    fy: { value: 1000 },
    cx: { value: 0.5 },
    cy: { value: 0.5 },
    k1: { value: 0 },
    k2: { value: 0 },
    p1: { value: 0 },
    p2: { value: 0 },
    enabled: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: DISTORTION_VERT,
    fragmentShader: DISTORTION_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);

  const scene = new THREE.Scene();
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    scene,
    camera,
    mesh,
    material,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Compute the extra FOV margin needed so the source render covers all the
 * pixels the distortion will pull in from "outside".
 *
 * Approximation: at the corner of the output image, what undistorted radius
 * would land there? We forward-distort the corner and use the ratio.
 *
 * Returns a multiplier ≥ 1 to scale the camera's effective focal length
 * (smaller focal = wider FOV → bigger source coverage).
 *
 * Note: when a calibration sidecar carries a measured `DISTORTION_SCALE`
 * (e.g. Nodos `extras.txt`), callers should use that value directly instead
 * of this estimator — it's the authoritative number for that exact lens/zoom.
 */
export function computeFovMargin(p: {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}): number {
  // Use the worst corner.
  const corners = [
    [0, 0],
    [p.width, 0],
    [0, p.height],
    [p.width, p.height],
  ];
  let maxRatio = 1;
  for (const [px, py] of corners) {
    const u = (px - p.cx) / p.fx;
    const v = (py - p.cy) / p.fy;
    const r2 = u * u + v * v;
    const radial = 1 + p.k1 * r2 + p.k2 * r2 * r2;
    const du = 2 * p.p1 * u * v + p.p2 * (r2 + 2 * u * u);
    const dv = p.p1 * (r2 + 2 * v * v) + 2 * p.p2 * u * v;
    const ud = u * radial + du;
    const vd = v * radial + dv;
    const inputR = Math.sqrt(u * u + v * v);
    const outputR = Math.sqrt(ud * ud + vd * vd);
    if (inputR > 0) {
      const ratio = outputR / inputR;
      if (ratio > maxRatio) maxRatio = ratio;
    }
  }
  // Cap the margin to keep the source resolution sensible.
  return Math.min(maxRatio, 2.0);
}
