import * as THREE from "three";
import {
  Output,
  VideoSample,
  VideoSampleSource,
  BufferTarget,
  Mp4OutputFormat,
} from "mediabunny";
import { createAvcEncodingConfig, AVC_LEVEL_4_0, AVC_LEVEL_5_1 } from "@/lib/video-encoding";
import { BASELINE_PIXEL_LIMIT, ensureEvenDimension } from "@/lib/video-probing";
import type { CameraPath } from "./cameraAnimation";
import { evaluateCameraPath } from "./cameraAnimation";

// ─── Types ──────────────────────────────────────────────────────

export interface VideoExportOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  path: CameraPath;
  mode: "rgb" | "depth" | "both";
  resolution: { width: number; height: number };
  bitrate?: number;
  /** Function that renders a depth frame and returns ImageData. Provided by page.tsx. */
  captureDepthFrame?: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number
  ) => ImageData | null;
  onProgress?: (frame: number, totalFrames: number) => void;
}

export interface VideoExportResult {
  rgb?: Blob;
  depth?: Blob;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_BITRATE = 8_000_000;

// ─── Export Function ────────────────────────────────────────────

export async function exportVideo(
  opts: VideoExportOptions
): Promise<VideoExportResult> {
  const {
    renderer,
    scene,
    camera,
    path,
    mode,
    resolution,
    bitrate = DEFAULT_BITRATE,
    captureDepthFrame,
    onProgress,
  } = opts;

  const width = ensureEvenDimension(resolution.width);
  const height = ensureEvenDimension(resolution.height);
  const totalFrames = path.durationFrames;
  const fps = path.fps;

  if (totalFrames <= 0 || path.keyframes.length < 2) {
    throw new Error("Need at least 2 keyframes and > 0 frames to export video");
  }

  const codecProfile =
    width * height > BASELINE_PIXEL_LIMIT ? AVC_LEVEL_5_1 : AVC_LEVEL_4_0;
  const resolvedBitrate = Math.max(1, Math.floor(bitrate));

  // Create offscreen render target at export resolution
  const renderTarget = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  // Save original camera/renderer state
  const origAspect = camera.aspect;
  const origFov = camera.fov;
  const origPos = camera.position.clone();
  const origQuat = camera.quaternion.clone();
  const origSize = renderer.getSize(new THREE.Vector2());

  const result: VideoExportResult = {};

  try {
    // ─── RGB pipeline ─────────────────────────────────────
    let rgbSource: VideoSampleSource | null = null;
    let rgbOutput: Output | null = null;
    let rgbBuffer: BufferTarget | null = null;

    if (mode === "rgb" || mode === "both") {
      rgbSource = new VideoSampleSource(
        createAvcEncodingConfig(resolvedBitrate, width, height, codecProfile, fps)
      );
      rgbBuffer = new BufferTarget();
      rgbOutput = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: rgbBuffer,
      });
      rgbOutput.addVideoTrack(rgbSource, { frameRate: fps });
      await rgbOutput.start();
    }

    // ─── Depth pipeline ───────────────────────────────────
    let depthSource: VideoSampleSource | null = null;
    let depthOutput: Output | null = null;
    let depthBuffer: BufferTarget | null = null;

    if ((mode === "depth" || mode === "both") && captureDepthFrame) {
      depthSource = new VideoSampleSource(
        createAvcEncodingConfig(resolvedBitrate, width, height, codecProfile, fps)
      );
      depthBuffer = new BufferTarget();
      depthOutput = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: depthBuffer,
      });
      depthOutput.addVideoTrack(depthSource, { frameRate: fps });
      await depthOutput.start();
    }

    // ─── Pixel read buffer ────────────────────────────────
    const pixelBuf = new Uint8Array(width * height * 4);
    const frameInterval = 1 / fps;

    // Offscreen canvas for creating VideoSample from pixel data
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const offCtx = offscreen.getContext("2d")!;

    // ─── Frame loop ───────────────────────────────────────
    for (let frame = 0; frame < totalFrames; frame++) {
      const evaluated = evaluateCameraPath(path, frame);
      if (!evaluated) continue;

      // Apply camera transform
      camera.position.copy(evaluated.position);
      camera.quaternion.copy(evaluated.quaternion);
      camera.fov = evaluated.fov;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      const timestampUs = Math.round(frame * frameInterval * 1_000_000);

      // ─── RGB frame ────────────────────────────────────
      if (rgbSource) {
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);

        renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixelBuf);

        // WebGL reads bottom-up; create ImageData with vertical flip
        const imageData = offCtx.createImageData(width, height);
        flipVerticallyInto(pixelBuf, imageData.data, width, height);
        offCtx.putImageData(imageData, 0, 0);

        // Create mediabunny VideoSample from canvas
        const sample = new VideoSample(offscreen, { timestamp: timestampUs });
        await rgbSource.add(sample);
        sample.close();
      }

      // ─── Depth frame ──────────────────────────────────
      if (depthSource && captureDepthFrame) {
        const depthImageData = captureDepthFrame(renderer, scene, camera, width, height);
        if (depthImageData) {
          offCtx.putImageData(depthImageData, 0, 0);
          const depthSample = new VideoSample(offscreen, { timestamp: timestampUs });
          await depthSource.add(depthSample);
          depthSample.close();
        }
      }

      onProgress?.(frame + 1, totalFrames);
    }

    // ─── Finalize ─────────────────────────────────────────
    if (rgbSource) {
      await rgbSource.close();
    }
    if (rgbOutput) {
      await rgbOutput.finalize();
      if (rgbBuffer?.buffer) {
        result.rgb = new Blob([rgbBuffer.buffer], { type: "video/mp4" });
      }
    }

    if (depthSource) {
      await depthSource.close();
    }
    if (depthOutput) {
      await depthOutput.finalize();
      if (depthBuffer?.buffer) {
        result.depth = new Blob([depthBuffer.buffer], { type: "video/mp4" });
      }
    }
  } finally {
    // Restore camera and renderer state
    camera.position.copy(origPos);
    camera.quaternion.copy(origQuat);
    camera.fov = origFov;
    camera.aspect = origAspect;
    camera.updateProjectionMatrix();
    renderer.setSize(origSize.x, origSize.y);
    renderTarget.dispose();

    // Re-render to screen
    renderer.render(scene, camera);
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Copy pixel buffer into ImageData with vertical flip (WebGL bottom-up → top-down) */
function flipVerticallyInto(
  src: Uint8Array,
  dst: Uint8ClampedArray,
  width: number,
  height: number
) {
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const srcOffset = y * rowBytes;
    const dstOffset = (height - 1 - y) * rowBytes;
    dst.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }
}
