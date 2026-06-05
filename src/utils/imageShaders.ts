/**
 * Fragment shaders for the GPU-native image-processing nodes.
 *
 * Each shader is a pure pixel transform on `texture2D(u_tex, v_uv)` and
 * declares its own uniforms. Paired with `processImageWithShader` in
 * `webglProcess.ts`.
 *
 * Math notes:
 *   - All processing is in sRGB display space (no gamma-decode → linear
 *     → gamma-encode round-trip). Matches the existing CPU `applyGrade`
 *     implementation byte-for-byte modulo float precision.
 *   - HSV uses the cleaner conditional-free formulation from Sam Hocevar.
 *   - Contrast roll-off uses a tanh-shaped S-curve so highlight/shadow
 *     squeeze approaches its asymptote smoothly rather than clipping.
 */

// ─── Nuke-style Grade (per-channel) ───────────────────────────────
//
// out = clamp(pow(in * A + B, 1/gamma), 0, 1)
// A   = multiply * (gain - lift) / (whitepoint - blackpoint)
// B   = offset + lift - blackpoint * A
//
// Each parameter is a vec3 so the user can unlink master mode and tune
// R/G/B independently — same shape as the existing CPU LUT builder.

export const GRADE_SHADER = /* glsl */ `
uniform vec3 u_blackpoint;
uniform vec3 u_whitepoint;
uniform vec3 u_lift;
uniform vec3 u_gain;
uniform vec3 u_multiply;
uniform vec3 u_offset;
uniform vec3 u_gamma;

void main() {
  vec4 src = texture2D(u_tex, v_uv);
  vec3 wbp = u_whitepoint - u_blackpoint;
  // Per-channel guard — for a singular channel (whitepoint==blackpoint)
  // mix(identity, graded) using a step.
  vec3 nonSingular = step(vec3(1e-6), abs(wbp));
  vec3 safeWbp = mix(vec3(1.0), wbp, nonSingular);
  vec3 A = u_multiply * (u_gain - u_lift) / safeWbp;
  vec3 B = u_offset + u_lift - u_blackpoint * A;
  vec3 linear = src.rgb * A + B;
  vec3 invGamma = vec3(1.0) / max(u_gamma, vec3(1e-6));
  // pow undefined for negative bases — clamp to 0 first.
  vec3 outRgb = pow(max(linear, vec3(0.0)), invGamma);
  // Where the channel is singular, pass through source unchanged.
  outRgb = mix(src.rgb, outRgb, nonSingular);
  gl_FragColor = vec4(clamp(outRgb, 0.0, 1.0), src.a);
}
`;

// ─── HSV Color Correct ───────────────────────────────────────────
//
// Hue shift (degrees), saturation multiplier, value (brightness)
// multiplier. Standard rgb⇄hsv round-trip; cheap (~8 ops) per pixel.

export const HSV_SHADER = /* glsl */ `
uniform float u_hueShift;     // degrees
uniform float u_saturation;   // multiplier; 1.0 = unchanged
uniform float u_value;        // multiplier; 1.0 = unchanged

// Sam Hocevar's branchless rgb→hsv.
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)),
              d / (q.x + e),
              q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 src = texture2D(u_tex, v_uv);
  vec3 hsv = rgb2hsv(src.rgb);
  hsv.x = fract(hsv.x + u_hueShift / 360.0);
  hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
  hsv.z = max(hsv.z * u_value, 0.0);
  vec3 rgb = clamp(hsv2rgb(hsv), 0.0, 1.0);
  gl_FragColor = vec4(rgb, src.a);
}
`;

// ─── Contrast Adjust with Roll-off ───────────────────────────────
//
// Plain linear contrast: out = (in - 0.5) * contrast + 0.5  → hard-clips.
// Roll-off contrast: tanh-shaped S-curve. As `rolloff` increases the
// curve's shoulder and toe ease asymptotically toward 0/1 instead of
// clipping. rolloff = 0 reduces to plain linear contrast for backward
// compatibility.
//
// Pivot defaults to 0.5 (neutral grey) but can be moved to lift / lower
// the midpoint — useful for grading dark scenes without crushing
// shadows or bright scenes without blowing highlights.

export const CONTRAST_SHADER = /* glsl */ `
uniform float u_contrast;     // 1.0 = unchanged. <1 = flatten, >1 = punch.
uniform float u_rolloff;      // 0..1; 0 = hard clip, 1 = full sigmoid.
uniform float u_pivot;        // 0..1; midpoint of the S-curve.

// tanh isn't a WebGL-1 / GLSL-ES-1.0 builtin (only WebGL2 has it), so
// implement it from exp. (exp(x) - exp(-x)) / (exp(x) + exp(-x)).
float myTanh(float x) {
  float e2x = exp(2.0 * x);
  return (e2x - 1.0) / (e2x + 1.0);
}

float softCurve(float x, float k) {
  // tanh-based soft squash. k controls how soft the asymptote is:
  // smaller k = harder, larger k = softer. We pick k from rolloff so
  // 0 = linear (k -> infinity would be exact linear; we approximate by
  // lerping to identity at rolloff=0).
  return 0.5 + 0.5 * myTanh(k * (x - 0.5));
}

void main() {
  vec4 src = texture2D(u_tex, v_uv);
  vec3 c = (src.rgb - vec3(u_pivot)) * u_contrast + vec3(u_pivot);
  // Soft-clip toward 0/1 via tanh-curve. The roll strength controls
  // how aggressive the asymptote is.
  float k = mix(20.0, 2.5, clamp(u_rolloff, 0.0, 1.0));  // soft → softer
  vec3 soft;
  soft.r = softCurve(c.r, k);
  soft.g = softCurve(c.g, k);
  soft.b = softCurve(c.b, k);
  // At rolloff = 0, use raw clamp (linear classical contrast).
  vec3 hard = clamp(c, 0.0, 1.0);
  vec3 outRgb = mix(hard, soft, clamp(u_rolloff, 0.0, 1.0));
  gl_FragColor = vec4(outRgb, src.a);
}
`;
