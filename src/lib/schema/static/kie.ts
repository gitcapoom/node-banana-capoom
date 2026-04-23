/**
 * Kie.ai static schemas.
 *
 * Kie.ai has no schema discovery API, so every supported model has a
 * hand-written ExtractedResult. If a model isn't in the lookup we return
 * `null` so the warmer can mark it unknown.
 */

import type { ExtractedResult } from "../types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";

const imageParams: ModelParameter[] = [
  { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
  { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
];

const flux2AspectRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "auto"];

type Raw = { parameters: ModelParameter[]; inputs: ModelInput[] };

const SCHEMAS: Record<string, Raw> = {
  // ============ Image models ============
  "z-image": {
    parameters: imageParams,
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "seedream/4.5-text-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], default: "1:1" },
      { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "seedream/4.5-edit": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], default: "1:1" },
      { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "gpt-image/1.5-text-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2"], default: "3:2" },
      { name: "quality", type: "string", description: "Output quality", enum: ["medium", "high"], default: "medium" },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "gpt-image/1.5-image-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2"], default: "3:2" },
      { name: "quality", type: "string", description: "Output quality", enum: ["medium", "high"], default: "medium" },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "flux-2/pro-text-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "flux-2/pro-image-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "flux-2/flex-text-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "flux-2/flex-image-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "nano-banana-pro": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2", "4:3", "16:9", "9:16", "21:9", "auto"], default: "1:1" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K", "4K"], default: "1K" },
      { name: "output_format", type: "string", description: "Output format", enum: ["png", "jpg"], default: "png" },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "image_input", type: "image", required: false, label: "Image", isArray: true },
    ],
  },
  "grok-imagine/text-to-image": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "1:1" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "grok-imagine/image-to-image": {
    parameters: [],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },

  // ============ Audio/TTS ============
  "elevenlabs/turbo-v2.5": {
    parameters: [
      { name: "voice_id", type: "string", description: "Voice ID to use for synthesis" },
      { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
      { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
      { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Text" }],
  },
  "elevenlabs/multilingual-v2": {
    parameters: [
      { name: "voice_id", type: "string", description: "Voice ID to use for synthesis" },
      { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
      { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
      { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Text" }],
  },
  "elevenlabs/text-to-dialogue-v3": {
    parameters: [
      { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
      { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
      { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Text / Dialogue Script" }],
  },
  "elevenlabs/sound-effect-v2": {
    parameters: [
      { name: "duration_seconds", type: "number", description: "Duration in seconds (0.5-22)", minimum: 0.5, maximum: 22 },
      { name: "loop", type: "boolean", description: "Enable smooth looping", default: false },
      { name: "prompt_influence", type: "number", description: "How closely to follow the prompt (0-1)", default: 0.3, minimum: 0, maximum: 1 },
      { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Sound Description" }],
  },

  // ============ Video ============
  "grok-imagine/text-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "2:3" },
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["6", "10"], default: "6" },
      { name: "mode", type: "string", description: "Generation mode", enum: ["fun", "normal", "spicy"], default: "normal" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "grok-imagine/image-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "2:3" },
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["6", "10"], default: "6" },
      { name: "mode", type: "string", description: "Generation mode", enum: ["fun", "normal", "spicy"], default: "normal" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "kling-2.6/text-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
      { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
      { name: "sound", type: "boolean", description: "Enable sound generation", default: true },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "kling-2.6/image-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
      { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
      { name: "sound", type: "boolean", description: "Enable sound generation", default: true },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "kling-2.6/motion-control": {
    parameters: [
      { name: "mode", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "720p" },
      { name: "character_orientation", type: "string", description: "Character orientation source", enum: ["image", "video"], default: "video" },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      { name: "video_urls", type: "video", required: true, label: "Video", isArray: true },
    ],
  },
  "kling/v2-5-turbo-text-to-video-pro": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
      { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
      { name: "cfg_scale", type: "number", description: "Guidance scale", minimum: 0, maximum: 1, default: 0.5 },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
    ],
  },
  "kling/v2-5-turbo-image-to-video-pro": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
      { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
      { name: "cfg_scale", type: "number", description: "Guidance scale", minimum: 0, maximum: 1, default: 0.5 },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
      { name: "image_url", type: "image", required: true, label: "Image" },
      { name: "tail_image_url", type: "image", required: false, label: "Tail Image" },
    ],
  },
  "wan/2-6-text-to-video": {
    parameters: [
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10", "15"], default: "5" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "wan/2-6-image-to-video": {
    parameters: [
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10", "15"], default: "5" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "wan/2-6-video-to-video": {
    parameters: [
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
      { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "video_urls", type: "video", required: true, label: "Video", isArray: true },
    ],
  },
  "runway/aleph-video-to-video": {
    parameters: [
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "720p" },
    ],
    inputs: [
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      { name: "video_url", type: "video", required: true, label: "Video" },
    ],
  },
  "luma/modify-video": {
    parameters: [
      { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "video_url", type: "video", required: true, label: "Video" },
    ],
  },
  "topaz/video-upscale": {
    parameters: [
      { name: "upscale_factor", type: "string", description: "Upscale factor", enum: ["1", "2", "4"], default: "2" },
    ],
    inputs: [{ name: "video_url", type: "video", required: true, label: "Video" }],
  },
  "veo3/text-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
      { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "veo3/image-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
      { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "imageUrls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
  "veo3-fast/text-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
      { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
  },
  "veo3-fast/image-to-video": {
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
      { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
    ],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
      { name: "imageUrls", type: "image", required: true, label: "Image", isArray: true },
    ],
  },
};

/**
 * Look up a Kie.ai model's static schema. Returns a clean ExtractedResult.
 * Returns `null` if this model isn't hand-mapped.
 */
export function getKieStaticSchema(modelId: string): ExtractedResult | null {
  const raw = SCHEMAS[modelId];
  if (!raw) return null;
  return {
    parameters: raw.parameters,
    inputs: raw.inputs,
    health: {
      status: "clean",
      warnings: [],
      extractedAt: Date.now(),
    },
  };
}
