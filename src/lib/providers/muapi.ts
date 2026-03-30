/**
 * muapi.ai Provider Implementation
 *
 * Implements ProviderInterface for muapi.ai's unified AI API.
 * Model list scraped from https://muapi.ai/playground
 *
 * To update: visit the playground, run in console:
 *   const links = document.querySelectorAll('a[href^="/playground/"]');
 *   // extract slugs + categories from DOM text content
 *
 * API Documentation: https://muapi.ai/docs/introduction
 */

import {
  ProviderInterface,
  ProviderModel,
  ModelCapability,
  GenerationInput,
  GenerationOutput,
  registerProvider,
} from "@/lib/providers";

const PROVIDER_SETTINGS_KEY = "node-banana-provider-settings";

function getApiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const settings = JSON.parse(localStorage.getItem(PROVIDER_SETTINGS_KEY) || "{}");
    return settings?.providers?.muapi?.apiKey || null;
  } catch {
    return null;
  }
}

/** Helper: generate ProviderModel from slug + capability */
function m(id: string, cap: ModelCapability): ProviderModel {
  const name = id
    .split("-")
    .map((w) => {
      const wl = w.toLowerCase();
      if (["i2v","t2v","i2i","t2i","v2v","xl","hd","4k","pro","std"].includes(wl)) return w.toUpperCase();
      if (wl.match(/^v\d/)) return w.toUpperCase();
      if (wl === "ai") return "AI";
      if (wl === "gpt4o") return "GPT-4o";
      if (wl === "openai") return "OpenAI";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
  return { id, name, provider: "muapi", capabilities: [cap], description: null };
}

/**
 * Complete muapi.ai model list — 284 models
 * Last updated: 2026-03-28 from https://muapi.ai/playground
 */
export const MUAPI_MODELS: ProviderModel[] = [
  // --- text-to-image (53) ---
  m("flux-dev", "text-to-image"),
  m("flux-2-klein-9b", "text-to-image"),
  m("flux-kontext-dev-t2i", "text-to-image"),
  m("hidream-i1-fast", "text-to-image"),
  m("hidream-i1-dev", "text-to-image"),
  m("hidream-i1-full", "text-to-image"),
  m("z-image-base", "text-to-image"),
  m("ai-anime-generator", "text-to-image"),
  m("flux-2-klein-4b-turbo", "text-to-image"),
  m("google-imagen4-fast", "text-to-image"),
  m("wan2.1-text-to-image", "text-to-image"),
  m("flux-kontext-pro-t2i", "text-to-image"),
  m("flux-kontext-max-t2i", "text-to-image"),
  m("gpt4o-text-to-image", "text-to-image"),
  m("midjourney-v7-text-to-image", "text-to-image"),
  m("bytedance-seedream-v3", "text-to-image"),
  m("flux-schnell", "text-to-image"),
  m("qwen-image", "text-to-image"),
  m("ideogram-v3-t2i", "text-to-image"),
  m("google-imagen4", "text-to-image"),
  m("bytedance-seedream-v4", "text-to-image"),
  m("google-imagen4-ultra", "text-to-image"),
  m("sdxl-image", "text-to-image"),
  m("hunyuan-image-2.1", "text-to-image"),
  m("chroma-image", "text-to-image"),
  m("flux-krea-dev", "text-to-image"),
  m("perfect-pony-xl", "text-to-image"),
  m("wan2.5-text-to-image", "text-to-image"),
  m("hunyuan-image-3.0", "text-to-image"),
  m("qwen-image-2.0-pro", "text-to-image"),
  m("leonardoai-phoenix-1.0", "text-to-image"),
  m("nano-banana", "text-to-image"),
  m("leonardoai-lucid-origin", "text-to-image"),
  m("neta-lumina", "text-to-image"),
  m("reve-text-to-image", "text-to-image"),
  m("grok-imagine-text-to-image", "text-to-image"),
  m("nano-banana-pro", "text-to-image"),
  m("kling-o1-text-to-image", "text-to-image"),
  m("z-image-turbo", "text-to-image"),
  m("flux-2-dev", "text-to-image"),
  m("flux-2-flex", "text-to-image"),
  m("flux-2-pro", "text-to-image"),
  m("vidu-q2-text-to-image", "text-to-image"),
  m("bytedance-seedream-v4.5", "text-to-image"),
  m("gpt-image-1.5", "text-to-image"),
  m("wan2.6-text-to-image", "text-to-image"),
  m("flux-2-klein-4b", "text-to-image"),
  m("bytedance-seedream-v5.0", "text-to-image"),
  m("nano-banana-2", "text-to-image"),
  m("z-image-p", "text-to-image"),
  m("qwen-image-2.0", "text-to-image"),
  m("tiktok-carousel", "text-to-image"),
  m("flux-2-klein-9b-turbo", "text-to-image"),

  // --- image-to-image (62) ---
  m("gpt4o-edit", "image-to-image"),
  m("ai-dress-change", "image-to-image"),
  m("ai-image-upscaler", "image-to-image"),
  m("flux-kontext-max-i2i", "image-to-image"),
  m("ai-image-face-swap", "image-to-image"),
  m("midjourney-v7-image-to-image", "image-to-image"),
  m("nano-banana-pro-edit", "image-to-image"),
  m("flux-2-klein-9b-edit", "image-to-image"),
  m("ai-background-remover", "image-to-image"),
  m("ai-product-shot", "image-to-image"),
  m("ai-skin-enhancer", "image-to-image"),
  m("ai-color-photo", "image-to-image"),
  m("qwen-image-edit-2511", "image-to-image"),
  m("flux-2-klein-4b-edit", "image-to-image"),
  m("add-image-watermark", "image-to-image"),
  m("bytedance-seedream-v5.0-edit", "image-to-image"),
  m("ai-product-photography", "image-to-image"),
  m("ai-ghibli-style", "image-to-image"),
  m("ai-image-extension", "image-to-image"),
  m("ai-object-eraser", "image-to-image"),
  m("seedance-v2.0-character", "image-to-image"),
  m("flux-kontext-pro-i2i", "image-to-image"),
  m("gpt4o-image-to-image", "image-to-image"),
  m("midjourney-v7-omni-reference", "image-to-image"),
  m("bytedance-seededit-v3", "image-to-image"),
  m("midjourney-v7-style-reference", "image-to-image"),
  m("minimax-image-01-subject-reference", "image-to-image"),
  m("ideogram-character", "image-to-image"),
  m("nano-banana-edit", "image-to-image"),
  m("flux-pulid", "image-to-image"),
  m("flux-redux", "image-to-image"),
  m("topaz-image-upscale", "image-to-image"),
  m("qwen-image-edit", "image-to-image"),
  m("ideogram-v3-reframe", "image-to-image"),
  m("bytedance-seedream-v4-edit", "image-to-image"),
  m("nano-banana-effects", "image-to-image"),
  m("flux-kontext-effects", "image-to-image"),
  m("flux-kontext-dev-i2i", "image-to-image"),
  m("qwen-image-edit-plus", "image-to-image"),
  m("wan2.5-image-edit", "image-to-image"),
  m("image-effects", "image-to-image"),
  m("photo-pack", "image-to-image"),
  m("higgsfield-soul-image-to-image", "image-to-image"),
  m("wan2.6-image-edit", "image-to-image"),
  m("reve-image-edit", "image-to-image"),
  m("flux-2-klein-4b-turbo-edit", "image-to-image"),
  m("seedvr2-image-upscale", "image-to-image"),
  m("qwen-image-edit-plus-lora", "image-to-image"),
  m("kling-o1-edit-image", "image-to-image"),
  m("flux-2-dev-edit", "image-to-image"),
  m("flux-2-flex-edit", "image-to-image"),
  m("flux-2-pro-edit", "image-to-image"),
  m("vidu-q2-reference-to-image", "image-to-image"),
  m("bytedance-seedream-v4.5-edit", "image-to-image"),
  m("gpt-image-1.5-edit", "image-to-image"),
  m("qwen-text-to-image-2512", "image-to-image"),
  m("grok-imagine-image-to-image", "image-to-image"),
  m("nano-banana-2-edit", "image-to-image"),
  m("qwen-image-2.0-edit", "image-to-image"),
  m("qwen-image-2.0-pro-edit", "image-to-image"),
  m("flux-2-klein-9b-turbo-edit", "image-to-image"),
  m("portrait-stylist", "image-to-image"),

  // --- text-to-video (48) ---
  m("veo3-text-to-video", "text-to-video"),
  m("veo3-fast-text-to-video", "text-to-video"),
  m("veo3.1-text-to-video", "text-to-video"),
  m("openai-sora-2-text-to-video", "text-to-video"),
  m("openai-sora-2-pro-text-to-video", "text-to-video"),
  m("seedance-v1.5-pro-t2v", "text-to-video"),
  m("wan2.2-5b-fast-t2v", "text-to-video"),
  m("runway-text-to-video", "text-to-video"),
  m("openai-sora", "text-to-video"),
  m("kling-v3.0-standard-text-to-video", "text-to-video"),
  m("wan2.1-text-to-video", "text-to-video"),
  m("hunyuan-text-to-video", "text-to-video"),
  m("hunyuan-fast-text-to-video", "text-to-video"),
  m("wan2.2-text-to-video", "text-to-video"),
  m("pixverse-v4.5-t2v", "text-to-video"),
  m("vidu-v2.0-t2v", "text-to-video"),
  m("wan2.5-text-to-video-fast", "text-to-video"),
  m("grok-imagine-text-to-video", "text-to-video"),
  m("minimax-hailuo-02-pro-t2v", "text-to-video"),
  m("seedance-lite-t2v", "text-to-video"),
  m("pixverse-v5-t2v", "text-to-video"),
  m("seedance-v1.5-pro-t2v-fast", "text-to-video"),
  m("kling-v3.0-pro-text-to-video", "text-to-video"),
  m("wan2.5-text-to-video", "text-to-video"),
  m("kling-v2.1-master-t2v", "text-to-video"),
  m("minimax-hailuo-02-standard-t2v", "text-to-video"),
  m("ltx-2.3-text-to-video", "text-to-video"),
  m("seedance-pro-t2v", "text-to-video"),
  m("kling-v2.5-turbo-pro-t2v", "text-to-video"),
  m("veo3.1-fast-text-to-video", "text-to-video"),
  m("openai-sora-2-pro-storyboard", "text-to-video"),
  m("ovi-text-to-video", "text-to-video"),
  m("veo3.1-extend-video", "text-to-video"),
  m("ltx-2-pro-text-to-video", "text-to-video"),
  m("seedance-pro-t2v-fast", "text-to-video"),
  m("ltx-2-fast-text-to-video", "text-to-video"),
  m("minimax-hailuo-2.3-pro-t2v", "text-to-video"),
  m("minimax-hailuo-2.3-standard-t2v", "text-to-video"),
  m("kling-o1-text-to-video", "text-to-video"),
  m("grok-imagine-extend", "text-to-video"),
  m("kling-v2.6-pro-t2v", "text-to-video"),
  m("pixverse-v5.5-t2v", "text-to-video"),
  m("wan2.6-text-to-video", "text-to-video"),
  m("ltx-2-19b-text-to-video", "text-to-video"),
  m("veo3.1-4k-video", "text-to-video"),
  m("seedance-v2.0-t2v", "text-to-video"),
  m("seedance-v2.0-extend", "text-to-video"),
  m("openai-sora-2-standard-text-to-video", "text-to-video"),

  // --- image-to-video (64) ---
  m("veo3-image-to-video", "image-to-video"),
  m("ai-video-effects", "image-to-video"),
  m("vfx", "image-to-video"),
  m("motion-controls", "image-to-video"),
  m("openai-sora-2-pro-image-to-video", "image-to-video"),
  m("veo3.1-image-to-video", "image-to-video"),
  m("openai-sora-2-image-to-video", "image-to-video"),
  m("runway-image-to-video", "image-to-video"),
  m("veo3-fast-image-to-video", "image-to-video"),
  m("wan2.1-image-to-video", "image-to-video"),
  m("kling-o1-standard-image-to-video", "image-to-video"),
  m("seedance-v2.0-omni-reference", "image-to-video"),
  m("hunyuan-image-to-video", "image-to-video"),
  m("midjourney-v7-image-to-video", "image-to-video"),
  m("kling-v2.1-master-i2v", "image-to-video"),
  m("kling-v2.1-standard-i2v", "image-to-video"),
  m("kling-v2.1-pro-i2v", "image-to-video"),
  m("wan2.2-image-to-video", "image-to-video"),
  m("runway-act-two-i2v", "image-to-video"),
  m("pixverse-v4.5-i2v", "image-to-video"),
  m("vidu-v2.0-i2v", "image-to-video"),
  m("minimax-hailuo-02-standard-i2v", "image-to-video"),
  m("minimax-hailuo-02-pro-i2v", "image-to-video"),
  m("seedance-lite-i2v", "image-to-video"),
  m("seedance-pro-i2v", "image-to-video"),
  m("seedance-lite-reference-video", "image-to-video"),
  m("seedance-v2.0-i2v", "image-to-video"),
  m("kling-v3.0-pro-image-to-video", "image-to-video"),
  m("vidu-q1-reference", "image-to-video"),
  m("wan2.5-image-to-video", "image-to-video"),
  m("wan2.5-image-to-video-fast", "image-to-video"),
  m("kling-v3.0-standard-image-to-video", "image-to-video"),
  m("kling-v2.5-turbo-pro-i2v", "image-to-video"),
  m("video-effects", "image-to-video"),
  m("ltx-2.3-image-to-video", "image-to-video"),
  m("ovi-image-to-video", "image-to-video"),
  m("pixverse-v5-i2v", "image-to-video"),
  m("leonardoai-motion-2.0", "image-to-video"),
  m("veo3.1-fast-image-to-video", "image-to-video"),
  m("veo3.1-reference-to-video", "image-to-video"),
  m("wan2.1-reference-video", "image-to-video"),
  m("higgsfield-dop-image-to-video", "image-to-video"),
  m("seedance-pro-i2v-fast", "image-to-video"),
  m("ltx-2-pro-image-to-video", "image-to-video"),
  m("ltx-2-fast-image-to-video", "image-to-video"),
  m("vidu-q2-reference", "image-to-video"),
  m("vidu-q2-turbo-start-end-video", "image-to-video"),
  m("vidu-q2-pro-start-end-video", "image-to-video"),
  m("minimax-hailuo-2.3-pro-i2v", "image-to-video"),
  m("minimax-hailuo-2.3-standard-i2v", "image-to-video"),
  m("minimax-hailuo-2.3-fast", "image-to-video"),
  m("kling-v2.5-turbo-std-i2v", "image-to-video"),
  m("grok-imagine-image-to-video", "image-to-video"),
  m("kling-o1-image-to-video", "image-to-video"),
  m("kling-o1-reference-to-video", "image-to-video"),
  m("kling-v2.6-pro-i2v", "image-to-video"),
  m("pixverse-v5.5-i2v", "image-to-video"),
  m("wan2.2-spicy-image-to-video", "image-to-video"),
  m("wan2.6-image-to-video", "image-to-video"),
  m("kling-o1-standard-reference-to-video", "image-to-video"),
  m("seedance-v1.5-pro-i2v", "image-to-video"),
  m("seedance-v1.5-pro-i2v-fast", "image-to-video"),
  m("ltx-2-19b-image-to-video", "image-to-video"),
  m("openai-sora-2-standard-image-to-video", "image-to-video"),

  // --- video-to-video (34) ---
  m("video-combiner", "video-to-video"),
  m("ai-video-face-swap", "video-to-video"),
  m("mmaudio-v2-video-to-video", "video-to-video"),
  m("ai-clipping", "video-to-video"),
  m("ai-captions", "video-to-video"),
  m("heygen-video-translate", "video-to-video"),
  m("kling-v2.6-std-motion-control", "video-to-video"),
  m("runway-act-two-v2v", "video-to-video"),
  m("seedance-v2.0-video-watermark-remover-pro", "video-to-video"),
  m("runway-aleph-v2v", "video-to-video"),
  m("luma-modify-video", "video-to-video"),
  m("luma-flash-reframe", "video-to-video"),
  m("ai-dance-effects", "video-to-video"),
  m("infinitetalk-video-to-video", "video-to-video"),
  m("ai-video-upscaler", "video-to-video"),
  m("wan2.2-animate", "video-to-video"),
  m("ai-video-upscaler-pro", "video-to-video"),
  m("video-watermark-remover", "video-to-video"),
  m("remix-video", "video-to-video"),
  m("add-video-watermark", "video-to-video"),
  m("seedance-v2.0-video-edit", "video-to-video"),
  m("wan2.2-edit-video", "video-to-video"),
  m("topaz-video-upscale", "video-to-video"),
  m("kling-o1-video-edit", "video-to-video"),
  m("kling-o1-video-edit-fast", "video-to-video"),
  m("wan2.2-spicy-video-extend", "video-to-video"),
  m("kling-o1-standard-video-edit", "video-to-video"),
  m("kling-v2.6-pro-motion-control", "video-to-video"),
  m("seedance-v1.5-pro-video-extend", "video-to-video"),
  m("seedance-v1.5-pro-video-extend-fast", "video-to-video"),
  m("seedance-v2.0-watermark-remover", "video-to-video"),
  m("ltx-2.3-video-extend", "video-to-video"),
  m("kling-v3.0-std-motion-control", "video-to-video"),
  m("kling-v3.0-pro-motion-control", "video-to-video"),

  // --- text-to-audio (11) ---
  m("mmaudio-v2-text-to-audio", "text-to-audio"),
  m("suno-remix-music", "text-to-audio"),
  m("suno-add-instrumental", "text-to-audio"),
  m("suno-create-music", "text-to-audio"),
  m("suno-extend-music", "text-to-audio"),
  m("suno-add-vocals", "text-to-audio"),
  m("suno-generate-sounds", "text-to-audio"),
  m("minimax-voice-clone", "text-to-audio"),
  m("minimax-speech-2.6-hd", "text-to-audio"),
  m("minimax-speech-2.6-turbo", "text-to-audio"),
  m("suno-generate-mashup", "text-to-audio"),

  // --- audio-to-video / lipsync (12) ---
  m("kling-v2-avatar-pro", "image-to-video"),
  m("sync-lipsync", "image-to-video"),
  m("latent-sync", "image-to-video"),
  m("creatify-lipsync", "image-to-video"),
  m("veed-lipsync", "image-to-video"),
  m("ltx-2-19b-lipsync", "image-to-video"),
  m("kling-v1-avatar-standard", "image-to-video"),
  m("kling-v1-avatar-pro", "image-to-video"),
  m("wan2.2-speech-to-video", "image-to-video"),
  m("infinitetalk-image-to-video", "image-to-video"),
  m("kling-v2-avatar-standard", "image-to-video"),
  m("ltx-2.3-lipsync", "image-to-video"),
];

/**
 * muapi.ai provider implementation
 */
const muapiProvider: ProviderInterface = {
  id: "muapi",
  name: "muapi.ai",

  async listModels(): Promise<ProviderModel[]> {
    return MUAPI_MODELS;
  },

  async getModel(modelId: string): Promise<ProviderModel | null> {
    return MUAPI_MODELS.find((mod) => mod.id === modelId) || null;
  },

  async searchModels(query: string): Promise<ProviderModel[]> {
    const q = query.toLowerCase();
    return MUAPI_MODELS.filter(
      (mod) =>
        mod.name.toLowerCase().includes(q) ||
        mod.id.toLowerCase().includes(q)
    );
  },

  async generate(): Promise<GenerationOutput> {
    return { success: false, error: "Use server-side handler for muapi.ai" };
  },

  isConfigured(): boolean {
    return getApiKey() !== null;
  },

  getApiKey,
};

registerProvider(muapiProvider);
