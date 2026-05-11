import * as THREE from "three";
import type { CameraPath, CameraKeyframe } from "./cameraAnimation";
import { evaluateCameraPath, createEmptyPath } from "./cameraAnimation";

// ─── COLMAP convention ──────────────────────────────────────────
//
// COLMAP camera frame is fixed by spec: RH, +X right, +Y down, +Z forward
// (the camera looks along +Z). The COLMAP *world* frame, however, is not
// pinned by the spec -- it inherits whatever convention the producing tool
// used. We model that with `ColmapWorldFrame`.
//
// Three.js scene frame: RH, +X right, +Y up, +Z back (camera looks -Z).
//
// images.txt holds, per image:
//   QW QX QY QZ = R_w2c quaternion (world-to-camera rotation), in COLMAP frame.
//   TX TY TZ    = world-to-camera translation, t = -R_w2c · camera_world_pos.
// Recover camera world position as: C = -R_w2c^T · t.
//
// The camera-axis frame change between Three.js cam (RUB) and COLMAP cam (RDF)
// is D = diag(1, -1, -1) = 180° about X. This is always applied on the camera
// side. The world-axis change depends on `ColmapWorldFrame` -- see
// `worldFrameToSceneRotation` below.

/**
 * Convention of the COLMAP *world* frame, i.e. the frame in which TX/TY/TZ
 * and the recovered camera positions are expressed. The COLMAP *camera*
 * frame (RDF) is spec-fixed and not configurable.
 */
export type ColmapWorldFrame = "y-up" | "y-down" | "z-up";

/**
 * Rotation that maps a vector expressed in the external COLMAP world frame
 * to the Three.js scene frame (Y-up, RUB).
 *   - "y-up":   identity. Source is already in glTF / Three.js / Maya / Unity convention.
 *   - "y-down": 180° about X. Raw COLMAP / OpenCV / vanilla SfM (Y-down, Z-forward).
 *   - "z-up":   -90° about X. Blender / Unreal / RealityCapture / Metashape (+Z up, +Y forward).
 *
 * The inverse (scene → external world) is the transpose, since all three are
 * proper rotations.
 */
export function worldFrameToSceneRotation(frame: ColmapWorldFrame): THREE.Matrix4 {
  switch (frame) {
    case "y-up":
      return new THREE.Matrix4().identity();
    case "y-down":
      return new THREE.Matrix4().makeRotationX(Math.PI);
    case "z-up":
      return new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  }
}

// Camera-axes change Three.js cam (RUB) ↔ COLMAP cam (RDF), as a Matrix4.
// 180° about X = diag(1, -1, -1, 1). Its own inverse.
const D_CAMERA_AXES = new THREE.Matrix4().makeRotationX(Math.PI);

// ─── COLMAP Export ──────────────────────────────────────────────

/**
 * Export a CameraPath as COLMAP-spec cameras.txt + images.txt bundled in a ZIP.
 * Output is standard COLMAP format and interoperates with COLMAP itself,
 * 3D Gaussian Splatting trainers, NerfStudio, etc.
 *
 * cameras.txt: PINHOLE model — CAMERA_ID PINHOLE WIDTH HEIGHT fx fy cx cy
 * images.txt:  IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID IMAGE_NAME (R_w2c, t).
 *
 * `worldFrame` selects the convention for the external world frame (defaults
 * to "y-down" = raw COLMAP / OpenCV). See `ColmapWorldFrame`.
 */
export async function exportColmap(
  path: CameraPath,
  width: number,
  height: number,
  sensorWidthMm: number,
  focalLengthMm: number,
  worldFrame: ColmapWorldFrame = "y-down"
): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  // ─── cameras.txt ────────────────────────────────────────
  // Single shared PINHOLE camera
  const focalLengthPx = (focalLengthMm / sensorWidthMm) * width;
  const cx = width / 2;
  const cy = height / 2;

  let camerasContent = "# Camera list with one line of data per camera:\n";
  camerasContent += "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n";
  camerasContent += `# Number of cameras: 1\n`;
  camerasContent += `1 PINHOLE ${width} ${height} ${focalLengthPx.toFixed(6)} ${focalLengthPx.toFixed(6)} ${cx.toFixed(6)} ${cy.toFixed(6)}\n`;

  zip.file("cameras.txt", camerasContent);

  // ─── images.txt ─────────────────────────────────────────
  let imagesContent = "# COLMAP poses. Standard format (colmap.github.io/format.html).\n";
  imagesContent += `# Camera frame: RH, +X right, +Y down, +Z forward (camera looks along +Z).\n`;
  imagesContent += `# World frame:  ${worldFrame}\n`;
  imagesContent += "# (QW, QX, QY, QZ) is the world-to-camera rotation R_w2c.\n";
  imagesContent += "# (TX, TY, TZ) is the world-to-camera translation: t = -R_w2c * camera_world_position.\n";
  imagesContent += "# Recover camera position in the COLMAP world frame as: C = -R_w2c^T * t.\n";
  imagesContent += "# Image list with two lines of data per image:\n";
  imagesContent += "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n";
  imagesContent += "#   POINTS2D[] as (X, Y, POINT3D_ID)\n";
  imagesContent += `# Number of images: ${path.durationFrames}\n`;

  // Rotation that maps scene (Three.js Y-up RUB) → external COLMAP world frame.
  const sceneToWorld = worldFrameToSceneRotation(worldFrame).clone().transpose();
  // Camera-axes change: Three.js cam (RUB) → COLMAP cam (RDF). Same matrix in both directions.
  const camAxes = D_CAMERA_AXES;

  const scratch = new THREE.Matrix4();

  for (let frame = 0; frame < path.durationFrames; frame++) {
    const cam = evaluateCameraPath(path, frame);
    if (!cam) continue;

    // R_c2w in scene frame, Three.js cam axes.
    const R_c2w_scene = scratch.makeRotationFromQuaternion(cam.quaternion).clone();

    // Compose: scene→world on the left, cam-axes change on the right.
    //   R_c2w_world_colmapCam = sceneToWorld · R_c2w_scene · D
    const R_c2w_world = new THREE.Matrix4()
      .multiplyMatrices(sceneToWorld, R_c2w_scene)
      .multiply(camAxes);

    const R_w2c = R_c2w_world.clone().transpose();
    const q_w2c = new THREE.Quaternion().setFromRotationMatrix(R_w2c);

    // Camera position in the external world frame, then t = -R_w2c · pos_world.
    const pos_world = cam.position.clone().applyMatrix4(sceneToWorld);
    const t = pos_world.clone().applyMatrix4(R_w2c).negate();

    const imageId = frame + 1;
    const imageName = `frame_${String(frame).padStart(5, "0")}.png`;

    // IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
    imagesContent += `${imageId} ${q_w2c.w.toFixed(8)} ${q_w2c.x.toFixed(8)} ${q_w2c.y.toFixed(8)} ${q_w2c.z.toFixed(8)} ${t.x.toFixed(8)} ${t.y.toFixed(8)} ${t.z.toFixed(8)} 1 ${imageName}\n`;
    // Empty POINTS2D line (no feature points)
    imagesContent += "\n";
  }

  zip.file("images.txt", imagesContent);

  // Also include a points3D.txt (empty, but expected by COLMAP readers)
  zip.file("points3D.txt", "# 3D point list (empty — no reconstruction)\n");

  return await zip.generateAsync({ type: "blob" });
}

// ─── COLMAP Import ──────────────────────────────────────────────

export interface ColmapImportResult {
  path: CameraPath;
  /** Camera intrinsics parsed from cameras.txt, if available */
  cameraParams: CameraParams | null;
}

/**
 * Import a COLMAP cameras.txt + images.txt (from a ZIP or individual files)
 * and return a CameraPath with keyframes at each image pose, plus camera intrinsics.
 */
export async function importColmap(
  zipBlob: Blob,
  fps = 25,
  worldFrame: ColmapWorldFrame = "y-down"
): Promise<ColmapImportResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(zipBlob);

  // Find cameras.txt, images.txt, and the optional Nodos extras.txt sidecar
  // (may be nested in a subfolder).
  let camerasFile: string | null = null;
  let imagesFile: string | null = null;
  let extrasFile: string | null = null;

  zip.forEach((relativePath) => {
    const lower = relativePath.toLowerCase();
    if (lower.endsWith("cameras.txt")) camerasFile = relativePath;
    if (lower.endsWith("images.txt")) imagesFile = relativePath;
    if (lower.endsWith("extras.txt")) extrasFile = relativePath;
  });

  if (!camerasFile || !imagesFile) {
    throw new Error("ZIP must contain cameras.txt and images.txt");
  }

  const camerasContent = await zip.file(camerasFile)!.async("text");
  const imagesContent = await zip.file(imagesFile)!.async("text");
  const extrasContent = extrasFile ? await zip.file(extrasFile)!.async("text") : null;

  // Parse cameras.txt → extract focal length for FOV calculation
  const cameraParams = parseCamerasTxt(camerasContent);

  // If extras.txt is present, fold DISTORTION_SCALE into cameraParams so the
  // viewer can use it as the FOV margin instead of estimating from k1/k2.
  if (cameraParams && extrasContent) {
    const extras = parseExtrasTxt(extrasContent);
    if (extras) cameraParams.distortionScale = extras.distortionScale;
  }

  // Parse images.txt → extract poses
  const poses = parseImagesTxt(imagesContent);

  if (poses.length === 0) {
    return { path: createEmptyPath(120, fps), cameraParams };
  }

  // Rotation that maps external COLMAP world frame → scene (Three.js Y-up RUB).
  const worldToScene = worldFrameToSceneRotation(worldFrame);
  const camAxes = D_CAMERA_AXES;

  // Convert COLMAP poses → Three.js CameraKeyframes
  const keyframes: CameraKeyframe[] = poses.map((pose, index) => {
    // images.txt holds R_w2c (COLMAP cam axes, external world) and t.
    const q_w2c = new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw);
    const R_w2c = new THREE.Matrix4().makeRotationFromQuaternion(q_w2c);
    const R_c2w_world_colmapCam = R_w2c.clone().transpose();

    // Camera position in the external world frame: C = -R_c2w · t.
    const t = new THREE.Vector3(pose.tx, pose.ty, pose.tz);
    const pos_world = t.clone().applyMatrix4(R_c2w_world_colmapCam).negate();

    // Compose: world→scene on the left, cam-axes change on the right.
    //   R_c2w_scene_threejsCam = worldToScene · R_c2w_world_colmapCam · D
    const R_c2w_scene = new THREE.Matrix4()
      .multiplyMatrices(worldToScene, R_c2w_world_colmapCam)
      .multiply(camAxes);
    const threeQ = new THREE.Quaternion().setFromRotationMatrix(R_c2w_scene);

    // Position frame change: pos_scene = worldToScene · pos_world.
    const posThree = pos_world.clone().applyMatrix4(worldToScene);

    // Compute FOV from camera intrinsics
    let fov = 60; // fallback
    if (cameraParams && cameraParams.fy > 0 && cameraParams.height > 0) {
      fov = 2 * Math.atan(cameraParams.height / (2 * cameraParams.fy)) * (180 / Math.PI);
    }

    return {
      time: poses.length > 1 ? index / (poses.length - 1) : 0,
      position: posThree,
      quaternion: threeQ,
      fov,
    };
  });

  return {
    path: {
      keyframes,
      durationFrames: poses.length,
      fps,
    },
    cameraParams,
  };
}

// ─── Parsing helpers ────────────────────────────────────────────

/**
 * The COLMAP camera models we recognise. Other models (FULL_OPENCV,
 * OPENCV_FISHEYE, etc.) are treated as best-effort PINHOLE — the focal
 * length and principal point still apply, but distortion is dropped.
 */
export type ColmapCameraModel =
  | "PINHOLE"
  | "SIMPLE_PINHOLE"
  | "OPENCV"
  | "RADIAL"
  | "SIMPLE_RADIAL";

export interface CameraParams {
  model: ColmapCameraModel;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** Brown-Conrady radial 2nd-order. Zero on PINHOLE. */
  k1: number;
  /** Brown-Conrady radial 4th-order. */
  k2: number;
  /** Brown-Conrady tangential P1. */
  p1: number;
  /** Brown-Conrady tangential P2. */
  p2: number;
  /**
   * Optional FOV-margin multiplier from a Nodos-style `extras.txt` sidecar
   * (column DISTORTION_SCALE). When present the renderer uses this directly
   * as the focal multiplier instead of estimating from k1/k2.
   */
  distortionScale?: number;
}

/**
 * Pull DISTORTION_SCALE from the first non-comment row of a Nodos
 * `extras.txt`. Schema:
 *   IMAGE_ID, ZOOM, FOCUS, FOCUS_DISTANCE, RENDER_RATIO, NODAL_OFFSET,
 *   DISTORTION_SCALE, SENSOR_W_MM, SENSOR_H_MM, ROT_X, ROT_Y, ROT_Z
 *
 * The shoot is one-camera in practice, so the value is uniform across rows;
 * we take the first row's value.
 */
export function parseExtrasTxt(content: string): { distortionScale: number } | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    // Index 6 = DISTORTION_SCALE (0-based after IMAGE_ID).
    if (parts.length >= 7) {
      const v = parseFloat(parts[6]);
      if (Number.isFinite(v) && v > 0) return { distortionScale: v };
    }
  }
  return null;
}

/**
 * Param packing per model, for reference:
 *   SIMPLE_PINHOLE: f, cx, cy
 *   PINHOLE:        fx, fy, cx, cy
 *   SIMPLE_RADIAL:  f, cx, cy, k1
 *   RADIAL:         f, cx, cy, k1, k2
 *   OPENCV:         fx, fy, cx, cy, k1, k2, p1, p2
 */
function parseCamerasTxt(content: string): CameraParams | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;

    const model = parts[1] as string;
    const width = parseFloat(parts[2]);
    const height = parseFloat(parts[3]);
    const p = parts.slice(4).map(parseFloat);

    const make = (over: Partial<CameraParams> & { fx: number; fy: number; cx: number; cy: number; model: ColmapCameraModel }): CameraParams => ({
      width, height,
      k1: 0, k2: 0, p1: 0, p2: 0,
      ...over,
    });

    switch (model) {
      case "SIMPLE_PINHOLE":
        if (p.length >= 3) return make({ model: "SIMPLE_PINHOLE", fx: p[0], fy: p[0], cx: p[1], cy: p[2] });
        break;
      case "PINHOLE":
        if (p.length >= 4) return make({ model: "PINHOLE", fx: p[0], fy: p[1], cx: p[2], cy: p[3] });
        break;
      case "SIMPLE_RADIAL":
        if (p.length >= 4) return make({ model: "SIMPLE_RADIAL", fx: p[0], fy: p[0], cx: p[1], cy: p[2], k1: p[3] });
        break;
      case "RADIAL":
        if (p.length >= 5) return make({ model: "RADIAL", fx: p[0], fy: p[0], cx: p[1], cy: p[2], k1: p[3], k2: p[4] });
        break;
      case "OPENCV":
        if (p.length >= 8) return make({
          model: "OPENCV",
          fx: p[0], fy: p[1], cx: p[2], cy: p[3],
          k1: p[4], k2: p[5], p1: p[6], p2: p[7],
        });
        break;
      default:
        // Unrecognised model — skip and continue scanning. If nothing else
        // matches we'll return null and the caller falls back to defaults.
        continue;
    }
  }
  return null;
}

interface ImagePose {
  imageId: number;
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  tx: number;
  ty: number;
  tz: number;
  cameraId: number;
  name: string;
}

function parseImagesTxt(content: string): ImagePose[] {
  const poses: ImagePose[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    // Image data line: IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
    if (parts.length >= 10) {
      poses.push({
        imageId: parseInt(parts[0]),
        qw: parseFloat(parts[1]),
        qx: parseFloat(parts[2]),
        qy: parseFloat(parts[3]),
        qz: parseFloat(parts[4]),
        tx: parseFloat(parts[5]),
        ty: parseFloat(parts[6]),
        tz: parseFloat(parts[7]),
        cameraId: parseInt(parts[8]),
        name: parts[9],
      });
      // Skip the POINTS2D line that follows each image line
      i++;
    }
  }

  // Sort by imageId to ensure correct frame order
  poses.sort((a, b) => a.imageId - b.imageId);
  return poses;
}
