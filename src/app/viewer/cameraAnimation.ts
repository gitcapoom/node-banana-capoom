import * as THREE from "three";

// ─── Types ──────────────────────────────────────────────────────

export type InterpolationMode = "linear" | "easeInOut" | "smooth";

export interface CameraKeyframe {
  /** Normalized time in [0, 1] along the animation path */
  time: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Vertical FOV in degrees */
  fov: number;
  /** Interpolation mode for the segment starting at this keyframe */
  interpolation?: InterpolationMode;
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
export function createEmptyPath(durationFrames = 120, fps = 24): CameraPath {
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
  };
}

// ─── Easing Functions ───────────────────────────────────────────

function applyEasing(t: number, mode: InterpolationMode): number {
  switch (mode) {
    case "linear":
      return t;
    case "easeInOut":
      // Cubic ease-in-out
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "smooth":
      // Smoothstep (Hermite)
      return t * t * (3 - 2 * t);
    default:
      return t;
  }
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

  // Apply easing based on the starting keyframe's interpolation mode
  const easingMode = kf0.interpolation ?? "smooth";
  const localT = applyEasing(rawT, easingMode);

  // ─── Position: Catmull-Rom spline ───────────────────────
  const position = interpolatePositionCatmullRom(keyframes, segIndex, localT);

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

// ─── Serialization (for JSON persistence) ───────────────────────

export interface SerializedCameraPath {
  keyframes: {
    time: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    fov: number;
    interpolation?: InterpolationMode;
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
    })),
    durationFrames: path.durationFrames,
    fps: path.fps,
  };
}

export function deserializePath(data: SerializedCameraPath): CameraPath {
  return {
    keyframes: data.keyframes.map((kf) => ({
      time: kf.time,
      position: new THREE.Vector3(kf.position[0], kf.position[1], kf.position[2]),
      quaternion: new THREE.Quaternion(kf.quaternion[0], kf.quaternion[1], kf.quaternion[2], kf.quaternion[3]),
      fov: kf.fov,
      interpolation: kf.interpolation,
    })),
    durationFrames: data.durationFrames,
    fps: data.fps,
  };
}
