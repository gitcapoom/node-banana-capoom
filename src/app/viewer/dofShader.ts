/**
 * Real-time depth-of-field for the SPZ Viewer.
 *
 * A fullscreen post-pass that consumes a colour texture and a linearised
 * depth texture (R channel = Z in metres, ≤ 0 = background marker) and
 * produces a defocus-blurred image using a single-pass scatter-as-gather
 * disk sampler.
 *
 * ## CoC (Circle of Confusion)
 *
 * Thin-lens model. Given:
 *   f  = focal length        (mm)
 *   D  = aperture diameter   (mm)            = f / N
 *   S  = focus distance      (m)
 *   Z  = pixel depth         (m)
 *
 *   CoC_mm = f · D · |Z − S| / (Z · (S − f/1000))
 *   CoC_px = CoC_mm · (imageWidth / sensorWidthMm)
 *
 * The CPU passes `focalMm`, `apertureMm`, `focusM`, and `pxPerMm`
 * (= passWidth / sensorWidthMm). The shader does the rest per pixel.
 * Clamp focusM ≥ focalMm/1000 + ε CPU-side to avoid the lens-equation
 * singularity.
 *
 * ## Scatter-as-gather
 *
 * Standard gather DoF (each output pixel averages a disk of neighbours)
 * suffers from in-focus foreground bleeding onto blurred background. The
 * fix is "scatter as gather": gather a fixed disk, but weight each
 * neighbour by whether *its own* CoC actually reaches the output pixel.
 *
 *   weight = clamp(sampleCoC − distFromCenter + 0.5, 0, 1)
 *
 * In-focus pixels (small CoC) only contribute within ~1 px of themselves.
 * Blurred pixels (large CoC) contribute out to their full CoC. Result: no
 * sharp foreground halos around blurred backgrounds.
 *
 * ## Disk pattern
 *
 * 24-tap golden-angle Vogel spiral. Quasi-random angular distribution
 * with `sqrt(t)` radial mapping gives uniform sample density across the
 * disk — better visual quality than a regular grid at the same tap count.
 *
 * ## Debug overlay
 *
 * `showCoC = 1` outputs a heatmap of |CoC_px| normalised by `maxBlurPx`
 * instead of the blurred colour, so the user can visually tune focus
 * distance: green at the focal plane, hot red at heavy defocus.
 */

import * as THREE from "three";

export interface DofUniforms {
  tColor: THREE.IUniform<THREE.Texture | null>;
  tDepth: THREE.IUniform<THREE.Texture | null>;
  resolution: THREE.IUniform<THREE.Vector2>;
  focalMm: THREE.IUniform<number>;
  apertureMm: THREE.IUniform<number>;
  focusM: THREE.IUniform<number>;
  pxPerMm: THREE.IUniform<number>;
  maxBlurPx: THREE.IUniform<number>;
  showCoC: THREE.IUniform<number>;
  enabled: THREE.IUniform<number>;
}

export const DOF_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export const DOF_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 resolution;

  uniform float focalMm;
  uniform float apertureMm;
  uniform float focusM;
  uniform float pxPerMm;
  uniform float maxBlurPx;
  uniform float showCoC;
  uniform float enabled;

  varying vec2 vUv;

  // Thin-lens CoC in pixels. Z ≤ 0 marks background → no blur.
  float computeCoC(float Z) {
    if (Z <= 0.0) return 0.0;
    float fm = focalMm * 0.001;                          // focal length, metres
    float denom = max(Z * (focusM - fm), 1e-4);          // guard near singularity
    float coCmm = focalMm * apertureMm * abs(Z - focusM) / denom;
    return clamp(coCmm * pxPerMm, 0.0, maxBlurPx);
  }

  // 24 golden-angle Vogel samples on the unit disk. Stored as direction
  // (xy) and normalised radius (z = sqrt(t/N)) — multiply z by the gather
  // radius in pixels at the call site.
  const int TAPS = 24;
  const float GOLDEN = 2.39996323;

  void main() {
    vec2 uv = vUv;

    if (enabled < 0.5) {
      gl_FragColor = texture2D(tColor, uv);
      return;
    }

    float centerZ = texture2D(tDepth, uv).r;
    float centerCoC = computeCoC(centerZ);

    // Debug: heat-map of |CoC_px| / maxBlurPx — green at focus, red at the
    // far edge of the blur range. Bypasses the disk sample entirely.
    if (showCoC > 0.5) {
      float n = clamp(centerCoC / max(maxBlurPx, 1.0), 0.0, 1.0);
      // green (focus) → yellow → red (defocused)
      vec3 col = mix(vec3(0.0, 1.0, 0.2), vec3(1.0, 0.0, 0.0), n);
      gl_FragColor = vec4(col, 1.0);
      return;
    }

    // Gather radius. Floor at 1 px so we always average ≥ a tiny neighbourhood
    // (cheap anti-aliasing for the in-focus case).
    float gatherR = max(centerCoC, 1.0);

    vec4 acc = texture2D(tColor, uv);
    float w = 1.0;

    for (int i = 0; i < TAPS; i++) {
      float t = (float(i) + 0.5) / float(TAPS);
      float r = sqrt(t);
      float theta = float(i) * GOLDEN;
      vec2 dirN = vec2(cos(theta), sin(theta)) * r;

      vec2 offsetPx = dirN * gatherR;
      vec2 sampleUv = uv + offsetPx / resolution;

      vec4 sCol = texture2D(tColor, sampleUv);
      float sZ = texture2D(tDepth, sampleUv).r;
      float sCoC = computeCoC(sZ);

      // Scatter-as-gather: contribute only if this sample's CoC reaches us.
      // The +0.5 / clamp gives a 1-px-wide soft edge for AA.
      float dist = length(offsetPx);
      float sw = clamp(sCoC - dist + 0.5, 0.0, 1.0);

      acc += sCol * sw;
      w += sw;
    }

    gl_FragColor = acc / max(w, 1e-4);
  }
`;

/**
 * Build a fullscreen-quad scene/material wired to the DoF shader.
 *
 * Mirrors the shape of `createDistortionPass` so the viewer can compose
 * the two passes interchangeably in its post chain.
 */
export function createDofPass(): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: DofUniforms;
  dispose: () => void;
} {
  const uniforms: DofUniforms = {
    tColor: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    focalMm: { value: 50 },
    apertureMm: { value: 50 / 2.8 },
    focusM: { value: 3.0 },
    pxPerMm: { value: 80 },
    maxBlurPx: { value: 60 },
    showCoC: { value: 0 },
    enabled: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: DOF_VERT,
    fragmentShader: DOF_FRAG,
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
