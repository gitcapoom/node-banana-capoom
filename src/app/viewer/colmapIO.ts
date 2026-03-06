import * as THREE from "three";
import type { CameraPath, CameraKeyframe } from "./cameraAnimation";
import { evaluateCameraPath, createEmptyPath } from "./cameraAnimation";

// ─── COLMAP Export ──────────────────────────────────────────────

/**
 * Export a CameraPath as COLMAP-format cameras.txt + images.txt bundled in a ZIP.
 *
 * COLMAP uses a right-handed coordinate system with Y-down, Z-forward.
 * Three.js uses Y-up, Z-out-of-screen. Conversion negates Y and Z.
 *
 * cameras.txt: PINHOLE model — CAMERA_ID PINHOLE WIDTH HEIGHT fx fy cx cy
 * images.txt: IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID IMAGE_NAME
 */
export async function exportColmap(
  path: CameraPath,
  width: number,
  height: number,
  sensorWidthMm: number,
  focalLengthMm: number
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
  let imagesContent = "# Image list with two lines of data per image:\n";
  imagesContent += "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n";
  imagesContent += "#   POINTS2D[] as (X, Y, POINT3D_ID)\n";
  imagesContent += `# Number of images: ${path.durationFrames}\n`;

  const rotMat = new THREE.Matrix4();

  for (let frame = 0; frame < path.durationFrames; frame++) {
    const cam = evaluateCameraPath(path, frame);
    if (!cam) continue;

    // Three.js → COLMAP coordinate conversion
    // COLMAP: Y-down, Z-forward. Three.js: Y-up, Z-backward.
    // Negate Y and Z components of both quaternion and position.
    const q = cam.quaternion.clone();

    // Build rotation matrix from Three.js quaternion
    rotMat.makeRotationFromQuaternion(q);
    const R = new THREE.Matrix3().setFromMatrix4(rotMat);

    // Convert to COLMAP coordinate system: flip Y and Z axes
    // R_colmap = diag(1, -1, -1) * R_threejs
    const re = R.elements; // column-major
    // Negate rows 1 and 2 (Y and Z rows)
    re[1] = -re[1]; re[4] = -re[4]; re[7] = -re[7]; // Y row
    re[2] = -re[2]; re[5] = -re[5]; re[8] = -re[8]; // Z row

    // Extract quaternion from COLMAP rotation matrix
    const colmapRotMat = new THREE.Matrix4().identity();
    colmapRotMat.elements[0] = re[0]; colmapRotMat.elements[1] = re[1]; colmapRotMat.elements[2] = re[2];
    colmapRotMat.elements[4] = re[3]; colmapRotMat.elements[5] = re[4]; colmapRotMat.elements[6] = re[5];
    colmapRotMat.elements[8] = re[6]; colmapRotMat.elements[9] = re[7]; colmapRotMat.elements[10] = re[8];
    const colmapQ = new THREE.Quaternion().setFromRotationMatrix(colmapRotMat);

    // COLMAP translation = -R * camera_position (world-to-camera transform)
    const pos = cam.position.clone();
    // Apply coordinate flip to position first
    pos.y = -pos.y;
    pos.z = -pos.z;
    // t = -R * pos
    const R3 = new THREE.Matrix3();
    R3.elements = [...re];
    const t = pos.clone().applyMatrix3(R3).negate();

    const imageId = frame + 1;
    const imageName = `frame_${String(frame).padStart(5, "0")}.png`;

    // IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
    imagesContent += `${imageId} ${colmapQ.w.toFixed(8)} ${colmapQ.x.toFixed(8)} ${colmapQ.y.toFixed(8)} ${colmapQ.z.toFixed(8)} ${t.x.toFixed(8)} ${t.y.toFixed(8)} ${t.z.toFixed(8)} 1 ${imageName}\n`;
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
  fps = 24
): Promise<ColmapImportResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(zipBlob);

  // Find cameras.txt and images.txt (may be nested in a subfolder)
  let camerasFile: string | null = null;
  let imagesFile: string | null = null;

  zip.forEach((relativePath) => {
    const lower = relativePath.toLowerCase();
    if (lower.endsWith("cameras.txt")) camerasFile = relativePath;
    if (lower.endsWith("images.txt")) imagesFile = relativePath;
  });

  if (!camerasFile || !imagesFile) {
    throw new Error("ZIP must contain cameras.txt and images.txt");
  }

  const camerasContent = await zip.file(camerasFile)!.async("text");
  const imagesContent = await zip.file(imagesFile)!.async("text");

  // Parse cameras.txt → extract focal length for FOV calculation
  const cameraParams = parseCamerasTxt(camerasContent);

  // Parse images.txt → extract poses
  const poses = parseImagesTxt(imagesContent);

  if (poses.length === 0) {
    return { path: createEmptyPath(120, fps), cameraParams };
  }

  // Convert COLMAP poses → Three.js CameraKeyframes
  const keyframes: CameraKeyframe[] = poses.map((pose, index) => {
    // Reverse the COLMAP → Three.js coordinate conversion
    // COLMAP: R_colmap = diag(1,-1,-1) * R_threejs
    // So: R_threejs = diag(1,-1,-1) * R_colmap (since diag(1,-1,-1) is its own inverse)

    const colmapQ = new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw);

    // Build COLMAP rotation matrix
    const colmapRotMat = new THREE.Matrix4().makeRotationFromQuaternion(colmapQ);
    const colmapRe = new THREE.Matrix3().setFromMatrix4(colmapRotMat).elements;

    // Recover position using the ORIGINAL COLMAP rotation BEFORE flipping
    // Export did: pos_colmap = diag(1,-1,-1)*pos_threejs, then t = -R_colmap * pos_colmap
    // So: pos_colmap = -R_colmap^T * t, then pos_threejs = diag(1,-1,-1)*pos_colmap
    const colmapR3 = new THREE.Matrix3();
    colmapR3.elements = [...colmapRe];
    const colmapR3T = colmapR3.clone().transpose();
    const t = new THREE.Vector3(pose.tx, pose.ty, pose.tz);
    const posColmap = t.clone().applyMatrix3(colmapR3T).negate();
    // Undo coordinate flip: COLMAP→Three.js
    posColmap.y = -posColmap.y;
    posColmap.z = -posColmap.z;

    // Now flip the rotation matrix to get Three.js rotation
    // Undo Y/Z flip: negate rows 1 and 2
    const re = [...colmapRe]; // work on a copy
    re[1] = -re[1]; re[4] = -re[4]; re[7] = -re[7];
    re[2] = -re[2]; re[5] = -re[5]; re[8] = -re[8];

    const threeRotMat = new THREE.Matrix4().identity();
    threeRotMat.elements[0] = re[0]; threeRotMat.elements[1] = re[1]; threeRotMat.elements[2] = re[2];
    threeRotMat.elements[4] = re[3]; threeRotMat.elements[5] = re[4]; threeRotMat.elements[6] = re[5];
    threeRotMat.elements[8] = re[6]; threeRotMat.elements[9] = re[7]; threeRotMat.elements[10] = re[8];
    const threeQ = new THREE.Quaternion().setFromRotationMatrix(threeRotMat);

    // Compute FOV from camera intrinsics
    let fov = 60; // fallback
    if (cameraParams && cameraParams.fy > 0 && cameraParams.height > 0) {
      fov = 2 * Math.atan(cameraParams.height / (2 * cameraParams.fy)) * (180 / Math.PI);
    }

    return {
      time: poses.length > 1 ? index / (poses.length - 1) : 0,
      position: posColmap,
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

export interface CameraParams {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

function parseCamerasTxt(content: string): CameraParams | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    // Format: CAMERA_ID MODEL WIDTH HEIGHT PARAMS...
    if (parts.length >= 8 && parts[1] === "PINHOLE") {
      return {
        width: parseFloat(parts[2]),
        height: parseFloat(parts[3]),
        fx: parseFloat(parts[4]),
        fy: parseFloat(parts[5]),
        cx: parseFloat(parts[6]),
        cy: parseFloat(parts[7]),
      };
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
