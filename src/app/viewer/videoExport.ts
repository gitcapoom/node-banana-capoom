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
  /** Renders a depth frame. If globalRange is provided, normalizes using that range.
   *  If globalRange is null, returns {min, max} for scanning (ImageData will be null). */
  captureDepthFrame?: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    globalRange?: { min: number; max: number }
  ) => { imageData: ImageData | null; min: number; max: number } | null;
  onProgress?: (frame: number, totalFrames: number) => void;
}

export interface VideoExportResult {
  rgb?: Blob;
  depth?: Blob;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_BITRATE = 20_000_000; // 20 Mbps

// ─── Capability check ───────────────────────────────────────────

function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

// ─── Export Function ────────────────────────────────────────────

export async function exportVideo(
  opts: VideoExportOptions
): Promise<VideoExportResult> {
  const webcodecs = hasWebCodecs();
  console.log(`[VideoExport] WebCodecs available: ${webcodecs}`);
  if (webcodecs) {
    try {
      return await exportVideoWebCodecs(opts);
    } catch (e) {
      console.warn("[VideoExport] WebCodecs failed, falling back to MediaRecorder:", e);
    }
  }
  return exportVideoMediaRecorder(opts);
}

// ─── WebCodecs + mp4-muxer export ──────────────────────────────

/**
 * Encode a sequence of ImageData frames into an MP4 blob using raw
 * WebCodecs VideoEncoder + mp4-muxer. This gives us full, exact control
 * over timestamps — no mediabunny wall-clock timing issues.
 */
async function encodeFramesToMp4(
  frames: ImageData[],
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<Blob> {
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");

  console.log(`[VideoExport] encodeFramesToMp4: ${frames.length} frames, ${width}x${height}, ${fps}fps, ${bitrate}bps`);
  const frameDurationUs = Math.round(1_000_000 / fps);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "avc",
      width,
      height,
    },
    fastStart: "in-memory",
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error("[VideoExport] Encoder error:", e);
    },
  });

  encoder.configure({
    codec: "avc1.640028", // H.264 High Level 4.0
    width,
    height,
    bitrate,
    framerate: fps,
    latencyMode: "quality",
    avc: { format: "avc" },
  });

  // Canvas for converting ImageData → VideoFrame
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  for (let i = 0; i < frames.length; i++) {
    ctx.putImageData(frames[i], 0, 0);

    const timestampUs = i * frameDurationUs;
    const vf = new VideoFrame(canvas, {
      timestamp: timestampUs,
      duration: frameDurationUs,
    });

    const keyFrame = i % (fps * 2) === 0; // keyframe every 2 seconds
    encoder.encode(vf, { keyFrame });
    vf.close();

    // Yield occasionally to avoid blocking
    if (i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  return new Blob([target.buffer], { type: "video/mp4" });
}

async function exportVideoWebCodecs(
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

  const needRgb = mode === "rgb" || mode === "both";
  const needDepth = (mode === "depth" || mode === "both") && !!captureDepthFrame;

  try {
    // ── Depth scan pass: find global min/max depth range ──────
    let globalDepthRange: { min: number; max: number } | null = null;
    if (needDepth && captureDepthFrame) {
      let globalMin = Infinity;
      let globalMax = -Infinity;
      for (let frame = 0; frame < totalFrames; frame++) {
        const evaluated = evaluateCameraPath(path, frame);
        if (!evaluated) continue;
        camera.position.copy(evaluated.position);
        camera.quaternion.copy(evaluated.quaternion);
        camera.fov = evaluated.fov;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();

        const result = captureDepthFrame(renderer, scene, camera, width, height);
        if (result) {
          if (result.min < globalMin) globalMin = result.min;
          if (result.max > globalMax) globalMax = result.max;
        }
        onProgress?.(frame + 1, totalFrames * (needRgb ? 3 : 2));
        if (frame % 3 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      if (globalMin < Infinity) {
        globalDepthRange = { min: globalMin, max: globalMax };
      }
    }

    // ── Render pass: capture all frames ─────────────────────────
    const rgbFrames: ImageData[] = [];
    const depthFrames: ImageData[] = [];
    const progressOffset = needDepth ? totalFrames : 0;
    const progressTotal = totalFrames * (needDepth ? (needRgb ? 3 : 2) : 1);

    for (let frame = 0; frame < totalFrames; frame++) {
      const evaluated = evaluateCameraPath(path, frame);
      if (!evaluated) continue;

      camera.position.copy(evaluated.position);
      camera.quaternion.copy(evaluated.quaternion);
      camera.fov = evaluated.fov;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      if (needRgb) {
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        safeReadPixels(renderer, renderTarget, 0, 0, width, height, pixelBuf);

        const imageData = new ImageData(width, height);
        flipVerticallyInto(pixelBuf, imageData.data, width, height);
        rgbFrames.push(imageData);
      }

      if (needDepth && captureDepthFrame && globalDepthRange) {
        const result = captureDepthFrame(renderer, scene, camera, width, height, globalDepthRange);
        depthFrames.push(result?.imageData ?? new ImageData(width, height));
      }

      onProgress?.(progressOffset + frame + 1, progressTotal);

      if (frame % 3 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // ── Pass 2: Encode to MP4 ──────────────────────────────────
    if (needRgb && rgbFrames.length > 0) {
      result.rgb = await encodeFramesToMp4(rgbFrames, width, height, fps, bitrate);
    }
    if (needDepth && depthFrames.length > 0) {
      result.depth = await encodeFramesToMp4(depthFrames, width, height, fps, bitrate);
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

  const rgbCanvas = document.createElement("canvas");
  rgbCanvas.width = width;
  rgbCanvas.height = height;
  const rgbCtx = rgbCanvas.getContext("2d")!;

  const depthCanvas = document.createElement("canvas");
  depthCanvas.width = width;
  depthCanvas.height = height;
  const depthCtx = depthCanvas.getContext("2d")!;

  const mimeType = pickRecorderMime();

  try {
    let rgbRecorder: MediaRecorder | null = null;
    let rgbChunks: Blob[] = [];
    if (mode === "rgb" || mode === "both") {
      const stream = rgbCanvas.captureStream(0);
      rgbRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      rgbRecorder.ondataavailable = (e) => { if (e.data.size > 0) rgbChunks.push(e.data); };
      rgbRecorder.start();
    }

    let depthRecorder: MediaRecorder | null = null;
    let depthChunks: Blob[] = [];
    if ((mode === "depth" || mode === "both") && captureDepthFrame) {
      const stream = depthCanvas.captureStream(0);
      depthRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      depthRecorder.ondataavailable = (e) => { if (e.data.size > 0) depthChunks.push(e.data); };
      depthRecorder.start();
    }

    for (let frame = 0; frame < totalFrames; frame++) {
      const frameStart = performance.now();
      const evaluated = evaluateCameraPath(path, frame);
      if (!evaluated) continue;

      camera.position.copy(evaluated.position);
      camera.quaternion.copy(evaluated.quaternion);
      camera.fov = evaluated.fov;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      if (rgbRecorder) {
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        safeReadPixels(renderer, renderTarget, 0, 0, width, height, pixelBuf);
        const imageData = rgbCtx.createImageData(width, height);
        flipVerticallyInto(pixelBuf, imageData.data, width, height);
        rgbCtx.putImageData(imageData, 0, 0);
        const rgbTrack = rgbRecorder.stream.getVideoTracks()[0] as MediaStreamVideoTrack & { requestFrame?: () => void };
        rgbTrack.requestFrame?.();
      }

      if (depthRecorder && captureDepthFrame) {
        const depthResult = captureDepthFrame(renderer, scene, camera, width, height);
        if (depthResult?.imageData) {
          depthCtx.putImageData(depthResult.imageData, 0, 0);
          const depthTrack = depthRecorder.stream.getVideoTracks()[0] as MediaStreamVideoTrack & { requestFrame?: () => void };
          depthTrack.requestFrame?.();
        }
      }

      onProgress?.(frame + 1, totalFrames);

      const elapsed = performance.now() - frameStart;
      if (elapsed < frameIntervalMs) {
        await new Promise((r) => setTimeout(r, frameIntervalMs - elapsed));
      } else if (frame % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (rgbRecorder) result.rgb = await stopRecorder(rgbRecorder, rgbChunks, mimeType);
    if (depthRecorder) result.depth = await stopRecorder(depthRecorder, depthChunks, mimeType);
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
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.stop();
  });
}

function pickRecorderMime(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "video/webm";
}

// ─── Helpers ────────────────────────────────────────────────────

/** Unbind any PIXEL_PACK_BUFFER that the splat renderer may have bound, then read pixels */
function safeReadPixels(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  x: number, y: number, w: number, h: number,
  buf: Uint8Array | Float32Array
) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (gl.PIXEL_PACK_BUFFER) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  renderer.readRenderTargetPixels(target, x, y, w, h, buf);
}

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
