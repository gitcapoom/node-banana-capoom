import * as THREE from "three";

// ─── Types ──────────────────────────────────────────────────────

export type InterpolationMode = "step" | "linear" | "easeInOut" | "smooth";

/**
 * A full snapshot of the animatable scene state at a keyframe — everything
 * other than the camera pose (which lives in the keyframe fields directly).
 * Stored as plain JSON (no THREE objects) so it serializes trivially and can be
 * interpolated generically. The concrete shapes live in SplatViewer; this module
 * only walks them structurally (numbers lerp, booleans/strings step, hex colors
 * blend, arrays/objects recurse), matching entities by id.
 *
 * `ibls` is captured for completeness/forward-compat but not yet applied live
 * (per-frame IBL re-grading is too expensive for 60fps playback).
 */
export interface SceneSnapshot {
  splatTransform?: unknown;
  meshes?: Array<{ id: string; transform: unknown; visible: boolean }>;
  lights?: Array<{ id: string; [k: string]: unknown }>;
  ibls?: Array<{ id: string; [k: string]: unknown }>;
  orbitTarget?: [number, number, number];
}

export interface CameraKeyframe {
  /** Normalized time in [0, 1] along the animation path */
  time: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Vertical FOV in degrees */
  fov: number;
  /** Interpolation mode for the segment starting at this keyframe */
  interpolation?: InterpolationMode;
  /** Full scene state at this keyframe (geometry/visibility/lights/…). */
  scene?: SceneSnapshot;
}

export interface CameraPath {
  keyframes: CameraKeyframe[];
  /** Total number of frames in the animation */
  durationFrames: number;
  /** Frames per second */
  fps: number;
}

export interface EvaluatedCamera {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

// ─── Path Helpers ───────────────────────────────────────────────

/** Create a default empty camera path */
export function createEmptyPath(durationFrames = 120, fps = 25): CameraPath {
  return { keyframes: [], durationFrames, fps };
}

/** Duration in seconds */
export function getPathDurationSeconds(path: CameraPath): number {
  return path.fps > 0 ? path.durationFrames / path.fps : 0;
}

/** Convert frame index to normalized time [0, 1] */
export function frameToTime(frame: number, totalFrames: number): number {
  if (totalFrames <= 1) return 0;
  return Math.max(0, Math.min(1, frame / (totalFrames - 1)));
}

/** Convert normalized time [0, 1] to frame index */
export function timeToFrame(time: number, totalFrames: number): number {
  return Math.round(Math.max(0, Math.min(1, time)) * (totalFrames - 1));
}

// ─── Keyframe CRUD ──────────────────────────────────────────────

/** Add a keyframe, replacing any existing keyframe at the same time. Returns new path. */
export function addKeyframe(path: CameraPath, kf: CameraKeyframe): CameraPath {
  // Replace if a keyframe exists within ~1 frame tolerance
  const tolerance = path.durationFrames > 1 ? 1 / (path.durationFrames - 1) * 0.5 : 0.01;
  const filtered = path.keyframes.filter(
    (existing) => Math.abs(existing.time - kf.time) > tolerance
  );
  const keyframes = [...filtered, cloneKeyframe(kf)].sort(
    (a, b) => a.time - b.time
  );
  return { ...path, keyframes };
}

/** Remove a keyframe by index. Returns new path. */
export function removeKeyframe(path: CameraPath, index: number): CameraPath {
  const keyframes = path.keyframes.filter((_, i) => i !== index);
  return { ...path, keyframes };
}

/** Update a keyframe at index with partial data. Returns new path (re-sorted). */
export function updateKeyframe(
  path: CameraPath,
  index: number,
  partial: Partial<CameraKeyframe>
): CameraPath {
  const keyframes = path.keyframes.map((kf, i) =>
    i === index ? { ...cloneKeyframe(kf), ...partial } : kf
  );
  keyframes.sort((a, b) => a.time - b.time);
  return { ...path, keyframes };
}

function cloneKeyframe(kf: CameraKeyframe): CameraKeyframe {
  return {
    time: kf.time,
    position: kf.position.clone(),
    quaternion: kf.quaternion.clone(),
    fov: kf.fov,
    interpolation: kf.interpolation,
    scene: kf.scene, // immutable plain-JSON snapshot — shallow ref is safe
  };
}

// ─── Easing Functions ───────────────────────────────────────────

/** Cubic ease-in-out: strong acceleration/deceleration at segment ends */
function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Interpolation ──────────────────────────────────────────────

/**
 * Evaluate the camera path at a given frame index.
 *
 * - Position: Catmull-Rom spline through keyframe positions
 * - Rotation: Sequential SLERP between neighboring keyframes
 * - FOV: Linear interpolation
 * - Easing: Applied per-segment based on the starting keyframe's interpolation mode
 *
 * Returns null if the path has no keyframes.
 */
export function evaluateCameraPath(
  path: CameraPath,
  frameIndex: number
): EvaluatedCamera | null {
  const { keyframes, durationFrames } = path;
  if (keyframes.length === 0) return null;

  // Single keyframe — return it directly
  if (keyframes.length === 1) {
    return {
      position: keyframes[0].position.clone(),
      quaternion: keyframes[0].quaternion.clone(),
      fov: keyframes[0].fov,
    };
  }

  const t = frameToTime(frameIndex, durationFrames);

  // Clamp to first/last keyframe if outside range
  if (t <= keyframes[0].time) {
    return {
      position: keyframes[0].position.clone(),
      quaternion: keyframes[0].quaternion.clone(),
      fov: keyframes[0].fov,
    };
  }
  if (t >= keyframes[keyframes.length - 1].time) {
    const last = keyframes[keyframes.length - 1];
    return {
      position: last.position.clone(),
      quaternion: last.quaternion.clone(),
      fov: last.fov,
    };
  }

  // Find the two keyframes that bracket t
  let segIndex = 0;
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (t >= keyframes[i].time && t <= keyframes[i + 1].time) {
      segIndex = i;
      break;
    }
  }

  const kf0 = keyframes[segIndex];
  const kf1 = keyframes[segIndex + 1];
  const segLen = kf1.time - kf0.time;
  const rawT = segLen > 0 ? (t - kf0.time) / segLen : 0;

  const mode = kf0.interpolation ?? "smooth";

  // ─── Mode-dependent interpolation ────────────────────────
  // step:      hold the start keyframe's value until the next key (no blend)
  // linear:    straight-line path, constant speed
  // smooth:    Catmull-Rom spline, constant speed (spline provides smoothness)
  // easeInOut: Catmull-Rom spline + cubic ease (decelerate at keyframes)

  let position: THREE.Vector3;
  let localT: number;

  if (mode === "step") {
    localT = 0; // hold kf0 for the whole segment
  } else if (mode === "easeInOut") {
    localT = easeInOutCubic(rawT);
  } else {
    localT = rawT; // both "linear" and "smooth" use raw t
  }

  if (mode === "linear" || mode === "step") {
    // Straight-line interpolation between kf0 and kf1 (step pins localT to 0)
    position = new THREE.Vector3().lerpVectors(kf0.position, kf1.position, localT);
  } else {
    // Catmull-Rom spline for "smooth" and "easeInOut"
    position = interpolatePositionCatmullRom(keyframes, segIndex, localT);
  }

  // ─── Rotation: SLERP between kf0 and kf1 ───────────────
  const quaternion = new THREE.Quaternion().slerpQuaternions(
    kf0.quaternion,
    kf1.quaternion,
    localT
  );

  // ─── FOV: Linear interpolation ─────────────────────────
  const fov = THREE.MathUtils.lerp(kf0.fov, kf1.fov, localT);

  return { position, quaternion, fov };
}

/**
 * Catmull-Rom interpolation for position through keyframe points.
 * Uses the segment's two endpoints plus the neighboring keyframes
 * (or clamped duplicates) as control points.
 */
function interpolatePositionCatmullRom(
  keyframes: CameraKeyframe[],
  segIndex: number,
  localT: number
): THREE.Vector3 {
  // Get 4 control points: p0 (before segment), p1 (start), p2 (end), p3 (after segment)
  const p1 = keyframes[segIndex].position;
  const p2 = keyframes[segIndex + 1].position;
  const p0 = segIndex > 0 ? keyframes[segIndex - 1].position : p1;
  const p3 =
    segIndex + 2 < keyframes.length
      ? keyframes[segIndex + 2].position
      : p2;

  // Catmull-Rom basis (centripetal alpha = 0.5 standard form simplified to uniform)
  const t = localT;
  const t2 = t * t;
  const t3 = t2 * t;

  const result = new THREE.Vector3();
  // Standard Catmull-Rom matrix coefficients
  result.x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  result.y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  result.z =
    0.5 *
    (2 * p1.z +
      (-p0.z + p2.z) * t +
      (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
      (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);

  return result;
}

// ─── Scene-state interpolation ──────────────────────────────────

/** Blend two #rrggbb hex colors per channel. */
function lerpHexColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return t >= 1 ? b : a;
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/**
 * Generic value interpolation used for scene snapshots:
 * numbers → linear lerp; booleans → step (hold `a` until the next keyframe);
 * hex colors → per-channel blend, other strings → step; arrays/objects → recurse.
 * A key missing on `b` holds `a`'s value.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lerpValue(a: any, b: any, t: number): any {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  if (typeof a === "boolean" || typeof b === "boolean") return t >= 1 ? b : a;
  if (typeof a === "string" && typeof b === "string") {
    if (/^#[0-9a-fA-F]{6}$/.test(a) && /^#[0-9a-fA-F]{6}$/.test(b)) return lerpHexColor(a, b, t);
    return t >= 1 ? b : a;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => lerpValue(v, b[i], t));
  if (a && b && typeof a === "object" && typeof b === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = { ...a };
    for (const k of Object.keys(a)) out[k] = lerpValue(a[k], b[k], t);
    return out;
  }
  return b === undefined ? a : b;
}

/** Interpolate two id-keyed entity arrays; entities only in one side are held. */
function interpEntities<T extends { id: string }>(
  aArr: T[] | undefined,
  bArr: T[] | undefined,
  t: number
): T[] | undefined {
  if (!aArr && !bArr) return undefined;
  const aMap = new Map((aArr ?? []).map((e) => [e.id, e]));
  const bMap = new Map((bArr ?? []).map((e) => [e.id, e]));
  const out: T[] = (aArr ?? []).map((ea) => {
    const eb = bMap.get(ea.id);
    return eb ? (lerpValue(ea, eb, t) as T) : ea;
  });
  for (const eb of bArr ?? []) if (!aMap.has(eb.id)) out.push(eb);
  return out;
}

/** Interpolate two scene snapshots at eased local time t∈[0,1]. */
export function interpolateScene(a: SceneSnapshot, b: SceneSnapshot, t: number): SceneSnapshot {
  const out: SceneSnapshot = {};
  if (a.splatTransform || b.splatTransform) {
    out.splatTransform = lerpValue(a.splatTransform ?? b.splatTransform, b.splatTransform ?? a.splatTransform, t);
  }
  if (a.orbitTarget || b.orbitTarget) {
    out.orbitTarget = lerpValue(a.orbitTarget ?? b.orbitTarget, b.orbitTarget ?? a.orbitTarget, t) as [number, number, number];
  }
  out.meshes = interpEntities(a.meshes, b.meshes, t);
  out.lights = interpEntities(a.lights, b.lights, t);
  out.ibls = interpEntities(a.ibls, b.ibls, t);
  return out;
}

/**
 * Evaluate the scene snapshot at a frame, mirroring evaluateCameraPath's
 * bracketing/clamping. Returns null when no keyframe carries scene data (so
 * camera-only paths and pre-Stage-3 saves behave exactly as before).
 */
export function evaluateSceneAtFrame(path: CameraPath, frameIndex: number): SceneSnapshot | null {
  const { keyframes, durationFrames } = path;
  if (keyframes.length === 0 || !keyframes.some((k) => k.scene)) return null;
  if (keyframes.length === 1) return keyframes[0].scene ?? null;

  const t = frameToTime(frameIndex, durationFrames);
  if (t <= keyframes[0].time) return keyframes[0].scene ?? null;
  if (t >= keyframes[keyframes.length - 1].time) return keyframes[keyframes.length - 1].scene ?? null;

  let segIndex = 0;
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (t >= keyframes[i].time && t <= keyframes[i + 1].time) { segIndex = i; break; }
  }
  const kf0 = keyframes[segIndex];
  const kf1 = keyframes[segIndex + 1];
  const segLen = kf1.time - kf0.time;
  const rawT = segLen > 0 ? (t - kf0.time) / segLen : 0;
  const sceneMode = kf0.interpolation ?? "smooth";
  const localT = sceneMode === "step" ? 0 : sceneMode === "easeInOut" ? easeInOutCubic(rawT) : rawT;

  if (kf0.scene && kf1.scene) return interpolateScene(kf0.scene, kf1.scene, localT);
  return kf0.scene ?? kf1.scene ?? null;
}

// ─── Serialization (for JSON persistence) ───────────────────────

export interface SerializedCameraPath {
  keyframes: {
    time: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    fov: number;
    interpolation?: InterpolationMode;
    scene?: SceneSnapshot;
  }[];
  durationFrames: number;
  fps: number;
}

export function serializePath(path: CameraPath): SerializedCameraPath {
  return {
    keyframes: path.keyframes.map((kf) => ({
      time: kf.time,
      position: [kf.position.x, kf.position.y, kf.position.z],
      quaternion: [kf.quaternion.x, kf.quaternion.y, kf.quaternion.z, kf.quaternion.w],
      fov: kf.fov,
      interpolation: kf.interpolation,
      scene: kf.scene,
    })),
    durationFrames: path.durationFrames,
    fps: path.fps,
  };
}

/** Tolerant of both the serialized [x,y,z] array form and the legacy
 *  JSON-flattened {x,y,z} object form (older saves stored raw Vector3s). */
function toVec3(p: unknown): THREE.Vector3 {
  if (Array.isArray(p)) return new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
  const o = (p ?? {}) as { x?: number; y?: number; z?: number };
  return new THREE.Vector3(o.x ?? 0, o.y ?? 0, o.z ?? 0);
}
function toQuat(q: unknown): THREE.Quaternion {
  if (Array.isArray(q)) return new THREE.Quaternion(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1);
  const o = (q ?? {}) as { x?: number; y?: number; z?: number; w?: number };
  return new THREE.Quaternion(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.w ?? 1);
}

export function deserializePath(data: SerializedCameraPath): CameraPath {
  return {
    keyframes: data.keyframes.map((kf) => ({
      time: kf.time,
      position: toVec3(kf.position),
      quaternion: toQuat(kf.quaternion),
      fov: kf.fov,
      interpolation: kf.interpolation,
      scene: kf.scene,
    })),
    durationFrames: data.durationFrames,
    fps: data.fps,
  };
}
