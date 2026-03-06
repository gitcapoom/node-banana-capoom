import * as THREE from "three";
import { ensureEvenDimension } from "@/lib/video-probing";
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

// ─── Capability check ───────────────────────────────────────────

function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

// ─── Export Function ────────────────────────────────────────────

export async function exportVideo(
  opts: VideoExportOptions
): Promise<VideoExportResult> {
  if (hasWebCodecs()) {
    return exportVideoWebCodecs(opts);
  }
  return exportVideoMediaRecorder(opts);
}

// ─── WebCodecs-based export (mediabunny) ────────────────────────

async function exportVideoWebCodecs(
  opts: VideoExportOptions
): Promise<VideoExportResult> {
  const {
    Output,
    VideoSample,
    VideoSampleSource,
    BufferTarget,
    Mp4OutputFormat,
  } = await import("mediabunny");
  const { createAvcEncodingConfig, AVC_LEVEL_4_0, AVC_LEVEL_5_1 } = await import("@/lib/video-encoding");
  const { BASELINE_PIXEL_LIMIT } = await import("@/lib/video-probing");

  const {
    renderer, scene, camera, path, mode, resolution,
    bitrate = DEFAULT_BITRATE, captureDepthFrame, onProgress,
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

  const renderTarget = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  const origAspect = camera.aspect;
  const origFov = camera.fov;
  const origPos = camera.position.clone();
  const origQuat = camera.quaternion.clone();
  const origSize = renderer.getSize(new THREE.Vector2());

  const result: VideoExportResult = {};

  try {
    let rgbSource: InstanceType<typeof VideoSampleSource> | null = null;
    let rgbOutput: InstanceType<typeof Output> | null = null;
    let rgbBuffer: InstanceType<typeof BufferTarget> | null = null;

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

    let depthSource: InstanceType<typeof VideoSampleSource> | null = null;
    let depthOutput: InstanceType<typeof Output> | null = null;
    let depthBuffer: InstanceType<typeof BufferTarget> | null = null;

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

    const pixelBuf = new Uint8Array(width * height * 4);
    const frameInterval = 1 / fps;

    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const offCtx = offscreen.getContext("2d")!;

    for (let frame = 0; frame < totalFrames; frame++) {
      const evaluated = evaluateCameraPath(path, frame);
      if (!evaluated) continue;

      camera.position.copy(evaluated.position);
      camera.quaternion.copy(evaluated.quaternion);
      camera.fov = evaluated.fov;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      const timestampUs = Math.round(frame * frameInterval * 1_000_000);

      if (rgbSource) {
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);

        renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixelBuf);

        const imageData = offCtx.createImageData(width, height);
        flipVerticallyInto(pixelBuf, imageData.data, width, height);
        offCtx.putImageData(imageData, 0, 0);

        const sample = new VideoSample(offscreen, { timestamp: timestampUs });
        await rgbSource.add(sample);
        sample.close();
      }

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

    if (rgbSource) await rgbSource.close();
    if (rgbOutput) {
      await rgbOutput.finalize();
      if (rgbBuffer?.buffer) {
        result.rgb = new Blob([rgbBuffer.buffer], { type: "video/mp4" });
      }
    }
    if (depthSource) await depthSource.close();
    if (depthOutput) {
      await depthOutput.finalize();
      if (depthBuffer?.buffer) {
        result.depth = new Blob([depthBuffer.buffer], { type: "video/mp4" });
      }
    }
  } finally {
    camera.position.copy(origPos);
    camera.quaternion.copy(origQuat);
    camera.fov = origFov;
    camera.aspect = origAspect;
    camera.updateProjectionMatrix();
    renderer.setSize(origSize.x, origSize.y);
    renderTarget.dispose();
    renderer.render(scene, camera);
  }

  return result;
}

// ─── MediaRecorder fallback ─────────────────────────────────────

/**
 * Fallback for browsers without WebCodecs (e.g. Firefox).
 * Renders frames to a canvas, uses captureStream + MediaRecorder to encode WebM.
 */
async function exportVideoMediaRecorder(
  opts: VideoExportOptions
): Promise<VideoExportResult> {
  const {
    renderer, scene, camera, path, mode, resolution,
    bitrate = DEFAULT_BITRATE, captureDepthFrame, onProgress,
  } = opts;

  const width = ensureEvenDimension(resolution.width);
  const height = ensureEvenDimension(resolution.height);
  const totalFrames = path.durationFrames;
  const fps = path.fps;

  if (totalFrames <= 0 || path.keyframes.length < 2) {
    throw new Error("Need at least 2 keyframes and > 0 frames to export video");
  }

  const renderTarget = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  const origAspect = camera.aspect;
  const origFov = camera.fov;
  const origPos = camera.position.clone();
  const origQuat = camera.quaternion.clone();
  const origSize = renderer.getSize(new THREE.Vector2());

  const result: VideoExportResult = {};
  const pixelBuf = new Uint8Array(width * height * 4);
  const frameIntervalMs = 1000 / fps;

  // Create canvases for recording
  const rgbCanvas = document.createElement("canvas");
  rgbCanvas.width = width;
  rgbCanvas.height = height;
  const rgbCtx = rgbCanvas.getContext("2d")!;

  const depthCanvas = document.createElement("canvas");
  depthCanvas.width = width;
  depthCanvas.height = height;
  const depthCtx = depthCanvas.getContext("2d")!;

  // Pick a supported MIME type
  const mimeType = pickRecorderMime();

  try {
    // Set up recorders
    let rgbRecorder: MediaRecorder | null = null;
    let rgbChunks: Blob[] = [];
    if (mode === "rgb" || mode === "both") {
      const stream = rgbCanvas.captureStream(0); // 0 = manual frame capture
      rgbRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitrate,
      });
      rgbRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) rgbChunks.push(e.data);
      };
      rgbRecorder.start();
    }

    let depthRecorder: MediaRecorder | null = null;
    let depthChunks: Blob[] = [];
    if ((mode === "depth" || mode === "both") && captureDepthFrame) {
      const stream = depthCanvas.captureStream(0);
      depthRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitrate,
      });
      depthRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) depthChunks.push(e.data);
      };
      depthRecorder.start();
    }

    // Frame loop
    for (let frame = 0; frame < totalFrames; frame++) {
      const evaluated = evaluateCameraPath(path, frame);
      if (!evaluated) continue;

      camera.position.copy(evaluated.position);
      camera.quaternion.copy(evaluated.quaternion);
      camera.fov = evaluated.fov;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      // RGB frame
      if (rgbRecorder) {
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);

        renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixelBuf);
        const imageData = rgbCtx.createImageData(width, height);
        flipVerticallyInto(pixelBuf, imageData.data, width, height);
        rgbCtx.putImageData(imageData, 0, 0);

        // Request a frame from the captureStream
        const rgbTrack = rgbRecorder.stream.getVideoTracks()[0] as MediaStreamVideoTrack & { requestFrame?: () => void };
        rgbTrack.requestFrame?.();
      }

      // Depth frame
      if (depthRecorder && captureDepthFrame) {
        const depthImageData = captureDepthFrame(renderer, scene, camera, width, height);
        if (depthImageData) {
          depthCtx.putImageData(depthImageData, 0, 0);
          const depthTrack = depthRecorder.stream.getVideoTracks()[0] as MediaStreamVideoTrack & { requestFrame?: () => void };
          depthTrack.requestFrame?.();
        }
      }

      onProgress?.(frame + 1, totalFrames);

      // Yield to the browser to keep UI responsive
      if (frame % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Stop recorders and wait for data
    if (rgbRecorder) {
      result.rgb = await stopRecorder(rgbRecorder, rgbChunks, mimeType);
    }
    if (depthRecorder) {
      result.depth = await stopRecorder(depthRecorder, depthChunks, mimeType);
    }
  } finally {
    camera.position.copy(origPos);
    camera.quaternion.copy(origQuat);
    camera.fov = origFov;
    camera.aspect = origAspect;
    camera.updateProjectionMatrix();
    renderer.setSize(origSize.x, origSize.y);
    renderTarget.dispose();
    renderer.render(scene, camera);
  }

  return result;
}

function stopRecorder(recorder: MediaRecorder, chunks: Blob[], mimeType: string): Promise<Blob> {
  return new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };
    recorder.stop();
  });
}

function pickRecorderMime(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "video/webm";
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
