/**
 * muapi.ai Provider Implementation
 *
 * Implements ProviderInterface for muapi.ai's unified AI API.
 * Uses hardcoded model list (no discovery API).
 *
 * API Documentation: https://muapi.ai/docs/introduction
 *
 * Usage:
 *   import "@/lib/providers/muapi"; // Just importing registers the provider
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

/**
 * Get API key from localStorage
 */
function getApiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const settings = JSON.parse(localStorage.getItem(PROVIDER_SETTINGS_KEY) || "{}");
    return settings?.providers?.muapi?.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * Curated muapi.ai model list
 */
export const MUAPI_MODELS: ProviderModel[] = [
  // --- Text-to-Image ---
  {
    id: "midjourney-v7-text-to-image",
    name: "Midjourney V7",
    description: "Midjourney V7 text-to-image generation via muapi.ai.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
  },
  {
    id: "google-imagen4-fast",
    name: "Google Imagen 4 Fast",
    description: "Google Imagen 4 fast text-to-image generation.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.04, currency: "USD" },
  },
  {
    id: "ideogram-v3-t2i",
    name: "Ideogram V3",
    description: "Ideogram V3 text-to-image with strong text rendering.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.04, currency: "USD" },
  },
  {
    id: "flux-kontext-pro-t2i",
    name: "Flux Kontext Pro T2I",
    description: "Flux Kontext Pro text-to-image generation.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.04, currency: "USD" },
  },
  {
    id: "flux-kontext-max-t2i",
    name: "Flux Kontext Max T2I",
    description: "Flux Kontext Max text-to-image — highest quality variant.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.08, currency: "USD" },
  },
  {
    id: "hidream-i1-fast",
    name: "HiDream I1 Fast",
    description: "HiDream I1 fast text-to-image generation.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.02, currency: "USD" },
  },
  {
    id: "seedream",
    name: "Seedream V3",
    description: "ByteDance Seedream V3 text-to-image generation.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.03, currency: "USD" },
  },
  {
    id: "wan2.1-text-to-image",
    name: "WAN 2.1 T2I",
    description: "WAN 2.1 text-to-image generation.",
    provider: "muapi",
    capabilities: ["text-to-image"],
    pricing: { type: "per-run", amount: 0.02, currency: "USD" },
  },

  // --- Image-to-Image ---
  {
    id: "gpt4o-image-to-image",
    name: "GPT-4o Edit",
    description: "GPT-4o image-to-image editing and transformation.",
    provider: "muapi",
    capabilities: ["image-to-image"],
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
  },
  {
    id: "flux-kontext-pro-i2i",
    name: "Flux Kontext Pro Edit",
    description: "Flux Kontext Pro image-to-image editing.",
    provider: "muapi",
    capabilities: ["image-to-image"],
    pricing: { type: "per-run", amount: 0.04, currency: "USD" },
  },
  {
    id: "flux-kontext-max-i2i",
    name: "Flux Kontext Max Edit",
    description: "Flux Kontext Max image-to-image — highest quality editing.",
    provider: "muapi",
    capabilities: ["image-to-image"],
    pricing: { type: "per-run", amount: 0.08, currency: "USD" },
  },
  {
    id: "midjourney-v7-image-to-image",
    name: "Midjourney V7 I2I",
    description: "Midjourney V7 image-to-image transformation.",
    provider: "muapi",
    capabilities: ["image-to-image"],
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
  },
  {
    id: "qwen-image-edit-2511",
    name: "Qwen Image Edit",
    description: "Qwen image editing model.",
    provider: "muapi",
    capabilities: ["image-to-image"],
    pricing: { type: "per-run", amount: 0.03, currency: "USD" },
  },
  {
    id: "ai-image-face-swap",
    name: "AI Face Swap",
    description: "AI-powered face swapping in images.",
    provider: "muapi",
    capabilities: ["image-to-image"],
    pricing: { type: "per-run", amount: 0.03, currency: "USD" },
  },

  // --- Text-to-Video ---
  {
    id: "openai-sora-2-text-to-video",
    name: "Sora 2 T2V",
    description: "OpenAI Sora 2 text-to-video generation.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },
  {
    id: "sora-2-pro-t2v",
    name: "Sora 2 Pro T2V",
    description: "OpenAI Sora 2 Pro text-to-video — higher quality.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.75, currency: "USD" },
  },
  {
    id: "veo3.1-text-to-video",
    name: "Veo 3.1 T2V",
    description: "Google Veo 3.1 text-to-video generation with audio.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },
  {
    id: "runway-text-to-video",
    name: "Runway T2V",
    description: "Runway text-to-video generation.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },
  {
    id: "seedance-pro",
    name: "Seedance Pro",
    description: "ByteDance Seedance Pro text-to-video generation.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.30, currency: "USD" },
  },
  {
    id: "hunyuan-t2v",
    name: "Hunyuan T2V",
    description: "Tencent Hunyuan text-to-video generation.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.20, currency: "USD" },
  },
  {
    id: "wan2.2-5b-fast-t2v",
    name: "WAN 2.2 Fast T2V",
    description: "WAN 2.2 5B fast text-to-video generation.",
    provider: "muapi",
    capabilities: ["text-to-video"],
    pricing: { type: "per-run", amount: 0.10, currency: "USD" },
  },

  // --- Image-to-Video ---
  {
    id: "sora-2-i2v",
    name: "Sora 2 I2V",
    description: "OpenAI Sora 2 image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },
  {
    id: "veo3-i2v",
    name: "Veo 3 I2V",
    description: "Google Veo 3 image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },
  {
    id: "hunyuan-i2v",
    name: "Hunyuan I2V",
    description: "Tencent Hunyuan image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.20, currency: "USD" },
  },
  {
    id: "wan2.2-image-to-video",
    name: "WAN 2.2 I2V",
    description: "WAN 2.2 image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.15, currency: "USD" },
  },
  {
    id: "wan2.5-image-to-video-fast",
    name: "WAN 2.5 I2V Fast",
    description: "WAN 2.5 fast image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.10, currency: "USD" },
  },
  {
    id: "grok-imagine-image-to-video",
    name: "Grok Imagine I2V",
    description: "xAI Grok Imagine image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.30, currency: "USD" },
  },
  {
    id: "kling-2.1-master-i2v",
    name: "Kling 2.1 Master I2V",
    description: "Kling 2.1 Master image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.30, currency: "USD" },
  },
  {
    id: "pixverse-v4.5-i2v",
    name: "PixVerse 4.5 I2V",
    description: "PixVerse 4.5 image-to-video generation.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.15, currency: "USD" },
  },

  // --- Video-to-Video ---
  {
    id: "runway-act-two-v2v",
    name: "Runway Act Two V2V",
    description: "Runway Act Two video-to-video generation.",
    provider: "muapi",
    capabilities: ["video-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },
  {
    id: "wan2.2-animate",
    name: "WAN 2.2 Animate",
    description: "WAN 2.2 character animation from reference video.",
    provider: "muapi",
    capabilities: ["video-to-video"],
    pricing: { type: "per-run", amount: 0.20, currency: "USD" },
  },
  {
    id: "infinitetalk-video-to-video",
    name: "InfiniteTalk V2V",
    description: "InfiniteTalk video-to-video transformation.",
    provider: "muapi",
    capabilities: ["video-to-video"],
    pricing: { type: "per-run", amount: 0.15, currency: "USD" },
  },
  {
    id: "heygen-video-translate",
    name: "HeyGen Video Translate",
    description: "HeyGen video translation and dubbing.",
    provider: "muapi",
    capabilities: ["video-to-video"],
    pricing: { type: "per-run", amount: 0.50, currency: "USD" },
  },

  // --- Audio ---
  {
    id: "mmaudio-v2",
    name: "MMAudio V2",
    description: "Video-to-audio generation — create soundtracks for videos.",
    provider: "muapi",
    capabilities: ["text-to-audio"],
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
  },
  {
    id: "suno-extend-music",
    name: "Suno Extend Music",
    description: "Extend and generate music with Suno AI.",
    provider: "muapi",
    capabilities: ["text-to-audio"],
    pricing: { type: "per-run", amount: 0.10, currency: "USD" },
  },

  // --- Lipsync / Avatar (image+audio → video) ---
  {
    id: "ltx-2-19b-lipsync",
    name: "LTX 2 19B Lipsync",
    description: "Generate lipsync video from image and audio.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.15, currency: "USD" },
  },
  {
    id: "kling-v2-avatar-pro",
    name: "Kling V2 Avatar Pro",
    description: "Kling V2 avatar generation from image and audio.",
    provider: "muapi",
    capabilities: ["image-to-video"],
    pricing: { type: "per-run", amount: 0.30, currency: "USD" },
  },
];

/**
 * muapi.ai provider implementation
 */
const muapiProvider: ProviderInterface = {
  id: "muapi",
  name: "muapi.ai",

  async listModels(): Promise<ProviderModel[]> {
    // Static list — no discovery API
    return MUAPI_MODELS;
  },

  async getModel(modelId: string): Promise<ProviderModel | null> {
    return MUAPI_MODELS.find((m) => m.id === modelId) || null;
  },

  async searchModels(query: string): Promise<ProviderModel[]> {
    const q = query.toLowerCase();
    return MUAPI_MODELS.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
    );
  },

  async generate(): Promise<GenerationOutput> {
    // Client-side generation not supported — use server-side handler
    return { success: false, error: "Use server-side handler for muapi.ai" };
  },

  isConfigured(): boolean {
    return getApiKey() !== null;
  },

  getApiKey,
};

// Auto-register
registerProvider(muapiProvider);
