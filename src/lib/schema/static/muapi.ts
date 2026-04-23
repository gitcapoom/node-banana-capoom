/**
 * muapi.ai slug-based fallback schemas.
 *
 * Used when the OpenAPI spec doesn't contain the requested model path. We
 * match the slug against known families (veo3.1, seedance, lipsync, etc.) and
 * return best-effort parameters + inputs.
 *
 * Keep this pragmatic: if we guess wrong on a parameter the server just
 * ignores it; the cost of missing one is a worse UX, but sending an unknown
 * one is usually harmless.
 */

import type { ExtractedResult } from "../types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";

function result(parameters: ModelParameter[], inputs: ModelInput[], note: string): ExtractedResult {
  return {
    parameters,
    inputs,
    health: {
      status: "heuristic-fallback",
      warnings: [`muapi slug-fallback: ${note}`],
      extractedAt: Date.now(),
    },
  };
}

export function getMuapiSlugSchema(modelId: string): ExtractedResult {
  const id = modelId.toLowerCase();

  const aspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"] };
  const videoAspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"] };
  const resolution: ModelParameter = { name: "resolution", type: "string", description: "Output resolution", enum: ["480p", "720p", "1080p"] };
  const duration: ModelParameter = { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "8", "10"] };
  const seed: ModelParameter = { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 };

  const nb2EditResolution: ModelParameter = { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"], default: "1k" };

  if (id === "nano-banana-2-edit") {
    return result(
      [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "1:4", "4:1", "1:8", "8:1"], default: "1:1" },
        nb2EditResolution,
        seed,
      ],
      [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
      `exact match: ${id}`,
    );
  }

  if (id === "nano-banana-pro-edit") {
    return result(
      [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"], default: "1k" },
        seed,
      ],
      [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
      `exact match: ${id}`,
    );
  }

  if (id === "nano-banana-edit") {
    return result(
      [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
        seed,
      ],
      [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
      `exact match: ${id}`,
    );
  }

  // Veo 3.1 — fixed duration=8, limited aspect ratios
  const veo31AspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" };
  const veo3AspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" };
  const veo31Duration: ModelParameter = { name: "duration", type: "integer", description: "Video duration in seconds (fixed)", enum: ["8"], default: "8" };

  if (id.startsWith("veo3.1") && (id.includes("i2v") || id.includes("image-to-video") || id.includes("reference-to-video"))) {
    return result(
      [veo31AspectRatio, veo31Duration, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
      `veo3.1 i2v: ${id}`,
    );
  }

  if (id.startsWith("veo3.1") && (id.includes("t2v") || id.includes("text-to-video") || id.includes("4k-video") || id.includes("extend"))) {
    return result(
      [veo31AspectRatio, veo31Duration, seed],
      [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
      `veo3.1 t2v: ${id}`,
    );
  }

  if (id.startsWith("veo3") && (id.includes("i2v") || id.includes("image-to-video"))) {
    return result(
      [veo3AspectRatio, duration, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
      `veo3 i2v: ${id}`,
    );
  }

  if (id.startsWith("veo3") && (id.includes("t2v") || id.includes("text-to-video"))) {
    return result(
      [veo3AspectRatio, duration, seed],
      [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
      `veo3 t2v: ${id}`,
    );
  }

  const seedanceQuality: ModelParameter = { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" };
  if (id.includes("seedance") && (id.includes("i2v") || id.includes("image-to-video"))) {
    return result(
      [videoAspectRatio, duration, seedanceQuality, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "first_frame", type: "image", required: true, label: "First Frame" },
        { name: "last_frame", type: "image", required: false, label: "Last Frame" },
      ],
      `seedance i2v: ${id}`,
    );
  }

  if (id.includes("start-end-video")) {
    return result(
      [videoAspectRatio, duration, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "start_image", type: "image", required: true, label: "Start Image" },
        { name: "end_image", type: "image", required: false, label: "End Image" },
      ],
      `start-end-video: ${id}`,
    );
  }

  const videoQuality: ModelParameter = { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"] };
  const imageResolution: ModelParameter = { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"] };

  if (
    id.includes("v2v") || id.includes("video-to-video") || id.includes("video-edit") ||
    id.includes("video-face-swap") || id.includes("video-translate") ||
    id.includes("video-upscaler") || id.includes("video-extend") ||
    id.includes("video-watermark") || id.includes("motion-control") ||
    id.includes("video-combiner") || id.includes("clipping") ||
    id.includes("animate") || id.includes("edit-video") ||
    id.includes("remix-video") || id.includes("captions") ||
    id.includes("luma-modify") || id.includes("luma-flash") ||
    id.includes("runway-aleph") || id.includes("dance-effects")
  ) {
    return result(
      [videoAspectRatio, duration, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "video_url", type: "image", required: true, label: "Video" },
      ],
      `video-to-video slug: ${id}`,
    );
  }

  if (id.includes("lipsync") || id.includes("avatar") || id.includes("speech-to-video")) {
    return result(
      [seed],
      [
        { name: "image_url", type: "image", required: true, label: "Image" },
        { name: "audio_url", type: "image", required: true, label: "Audio" },
      ],
      `lipsync/avatar slug: ${id}`,
    );
  }

  if (
    id.includes("i2v") || id.includes("image-to-video") || id.includes("reference-to-video") ||
    id.includes("reference-video") || id.includes("start-end-video") ||
    id.includes("video-effects") || id.includes("vfx") || id.includes("motion-controls")
  ) {
    return result(
      [videoAspectRatio, resolution, duration, videoQuality, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_url", type: "image", required: true, label: "Image" },
      ],
      `i2v slug: ${id}`,
    );
  }

  if (id.includes("t2v") || id.includes("text-to-video") || id.includes("4k-video")) {
    return result(
      [videoAspectRatio, resolution, duration, videoQuality, seed],
      [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
      `t2v slug: ${id}`,
    );
  }

  if (
    id.includes("i2i") || id.includes("image-to-image") || id.includes("-edit") ||
    id.includes("face-swap") || id.includes("upscaler") || id.includes("upscale") ||
    id.includes("background-remover") || id.includes("object-eraser") ||
    id.includes("skin-enhancer") || id.includes("color-photo") ||
    id.includes("product-shot") || id.includes("product-photography") ||
    id.includes("ghibli-style") || id.includes("image-extension") ||
    id.includes("watermark") || id.includes("pulid") || id.includes("redux") ||
    id.includes("reframe") || id.includes("character") || id.includes("reference-to-image") ||
    id.includes("effects") || id.includes("photo-pack") || id.includes("portrait-stylist") ||
    id.includes("dress-change") || id.includes("omni-reference") || id.includes("style-reference")
  ) {
    return result(
      [aspectRatio, imageResolution, seed],
      [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_url", type: "image", required: true, label: "Image" },
      ],
      `i2i slug: ${id}`,
    );
  }

  if (
    id.includes("music") || id.includes("audio") || id.includes("speech") ||
    id.includes("vocals") || id.includes("instrumental") || id.includes("sounds") ||
    id.includes("voice-clone") || id.includes("lyrics") || id.includes("mashup")
  ) {
    return result(
      [seed],
      [{ name: "prompt", type: "text", required: true, label: "Text" }],
      `audio slug: ${id}`,
    );
  }

  // Default: text-to-image
  return result(
    [aspectRatio, imageResolution, seed],
    [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    `text-to-image default: ${id}`,
  );
}
