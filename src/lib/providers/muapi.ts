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
 * Comprehensive muapi.ai model list
 * Source: https://muapi.ai/playground
 */
export const MUAPI_MODELS: ProviderModel[] = [
  // ─── Text-to-Image (53 models) ───
  { id: "flux-dev", name: "Flux Dev", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-kontext-max-t2i", name: "Flux Kontext Max T2I", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-kontext-dev-t2i", name: "Flux Kontext Dev T2I", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-kontext-pro-t2i", name: "Flux Kontext Pro T2I", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "gpt4o-text-to-image", name: "GPT-4o Text to Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "wan2.1-text-to-image", name: "WAN 2.1 Text to Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "midjourney-v7-text-to-image", name: "Midjourney V7", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "bytedance-seedream-v3", name: "Seedream V3", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-schnell", name: "Flux Schnell", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "qwen-image", name: "Qwen Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "hidream-i1-fast", name: "HiDream I1 Fast", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "hidream-i1-dev", name: "HiDream I1 Dev", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "hidream-i1-full", name: "HiDream I1 Full", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "z-image-base", name: "Z Image Base", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "google-imagen4-fast", name: "Google Imagen 4 Fast", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "google-imagen4", name: "Google Imagen 4", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "google-imagen4-ultra", name: "Google Imagen 4 Ultra", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "ideogram-v3-t2i", name: "Ideogram V3 T2I", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "bytedance-seedream-v4", name: "Seedream V4", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "nan-banana-pro", name: "Nan Banana Pro", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-2-klein-9b", name: "Flux 2 Klein 9B", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-2-klein-4b-turbo", name: "Flux 2 Klein 4B Turbo", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "perfect-pony-xl", name: "Perfect Pony XL", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "sdxl-image", name: "SDXL Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "hunyuan-image-2.1", name: "Hunyuan Image 2.1", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "chroma-image", name: "Chroma Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-krea-dev", name: "Flux Krea Dev", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "grok-imagine-text-to-image", name: "Grok Imagine T2I", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "leonardoai-phoenix-1.0", name: "Leonardo Phoenix 1.0", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "leonardoai-lucid-origin", name: "Leonardo Lucid Origin", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "nano-banana", name: "Nano Banana", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "nan-banana-2", name: "Nan Banana 2", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "z-image-turbo", name: "Z Image Turbo", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "z-image-p", name: "Z Image P", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-2-dev", name: "Flux 2 Dev", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-2-flex", name: "Flux 2 Flex", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-2-pro", name: "Flux 2 Pro", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "vidu-q2-text-to-image", name: "Vidu Q2 T2I", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "bytedance-seedream-v4.5", name: "Seedream V4.5", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "wan2.5-text-to-image", name: "WAN 2.5 Text to Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "wan2.6-text-to-image", name: "WAN 2.6 Text to Image", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "qwen-text-to-image-2512", name: "Qwen T2I 2512", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "qwen-image-2.0", name: "Qwen Image 2.0", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "hunyuan-image-3.0", name: "Hunyuan Image 3.0", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "bytedance-seedream-v5.0", name: "Seedream V5.0", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "neta-lumina", name: "Neta Lumina", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "flux-2-klein-4b", name: "Flux 2 Klein 4B", provider: "muapi", capabilities: ["text-to-image"], description: null },
  { id: "reve-text-to-image", name: "Reve Text to Image", provider: "muapi", capabilities: ["text-to-image"], description: null },

  // ─── Text-to-Video (44 models) ───
  { id: "veo3-text-to-video", name: "Veo 3 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "veo3-fast-text-to-video", name: "Veo 3 Fast T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "openai-sora-2-text-to-video", name: "Sora 2 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "openai-sora-2-pro-text-to-video", name: "Sora 2 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "seedance-v1.5-pro-t2v", name: "Seedance V1.5 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "wan2.2-5b-fast-t2v", name: "WAN 2.2 5B Fast T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "wan2.1-text-to-video", name: "WAN 2.1 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "openai-sora", name: "OpenAI Sora", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "kling-v3.0-standard-text-to-video", name: "Kling V3.0 Standard T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "runway-text-to-video", name: "Runway T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "hunyuan-text-to-video", name: "Hunyuan T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "hunyuan-fast-text-to-video", name: "Hunyuan Fast T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "vidu-v2.0-t2v", name: "Vidu V2.0 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "kling-v2.1-master-t2v", name: "Kling V2.1 Master T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "pixverse-v4.5-t2v", name: "PixVerse V4.5 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "grok-imagine-text-to-video", name: "Grok Imagine T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "seedance-lite-t2v", name: "Seedance Lite T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "seedance-pro-t2v", name: "Seedance Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "wan2.5-text-to-video-fast", name: "WAN 2.5 T2V Fast", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "wan2.5-text-to-video", name: "WAN 2.5 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "minimax-hailuo-02-pro-t2v", name: "Hailuo 02 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "minimax-hailuo-02-standard-t2v", name: "Hailuo 02 Standard T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "veo3.1-text-to-video", name: "Veo 3.1 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "veo3.1-fast-text-to-video", name: "Veo 3.1 Fast T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "seedance-v1.5-pro-t2v-fast", name: "Seedance V1.5 Pro T2V Fast", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "kling-v2.6-pro-t2v", name: "Kling V2.6 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "pixverse-v5-t2v", name: "PixVerse V5 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "wan2.2-text-to-video", name: "WAN 2.2 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "ltx-2-pro-text-to-video", name: "LTX 2 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "ltx-2-fast-text-to-video", name: "LTX 2 Fast T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "seedance-pro-t2v-fast", name: "Seedance Pro T2V Fast", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "minimax-hailuo-2.3-pro-t2v", name: "Hailuo 2.3 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "minimax-hailuo-2.3-standard-t2v", name: "Hailuo 2.3 Standard T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "kling-v3.0-pro-text-to-video", name: "Kling V3.0 Pro T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "kling-o1-text-to-video", name: "Kling O1 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "grok-imagine-extend", name: "Grok Imagine Extend", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "ovi-text-to-video", name: "Ovi T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "ltx-2.3-text-to-video", name: "LTX 2.3 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "seedance-v2.0-t2v", name: "Seedance V2.0 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "wan2.6-text-to-video", name: "WAN 2.6 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "pixverse-v5.5-t2v", name: "PixVerse V5.5 T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "ltx-2-19b-text-to-video", name: "LTX 2 19B T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "veo3.1-4k-video", name: "Veo 3.1 4K Video", provider: "muapi", capabilities: ["text-to-video"], description: null },
  { id: "openai-sora-2-standard-text-to-video", name: "Sora 2 Standard T2V", provider: "muapi", capabilities: ["text-to-video"], description: null },

  // ─── Image-to-Video (59 models) ───
  { id: "veo3-image-to-video", name: "Veo 3 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "ai-video-effects", name: "AI Video Effects", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "vfx", name: "VFX", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "motion-controls", name: "Motion Controls", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.1-lora-i2v", name: "WAN 2.1 LoRA I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "openai-sora-2-pro-image-to-video", name: "Sora 2 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "veo3.1-image-to-video", name: "Veo 3.1 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "openai-sora-2-image-to-video", name: "Sora 2 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "runway-image-to-video", name: "Runway I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "veo3-fast-image-to-video", name: "Veo 3 Fast I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v2.1-master-i2v", name: "Kling V2.1 Master I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v2.1-standard-i2v", name: "Kling V2.1 Standard I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v2.1-pro-i2v", name: "Kling V2.1 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.2-image-to-video", name: "WAN 2.2 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "runway-act-two-i2v", name: "Runway Act Two I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "pixverse-v4.5-i2v", name: "PixVerse V4.5 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "vidu-v2.0-i2v", name: "Vidu V2.0 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-o1-standard-image-to-video", name: "Kling O1 Standard I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "midjourney-v7-image-to-video", name: "Midjourney V7 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "hunyuan-image-to-video", name: "Hunyuan I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.1-image-to-video", name: "WAN 2.1 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "seedance-lite-i2v", name: "Seedance Lite I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "seedance-pro-i2v", name: "Seedance Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v3.0-standard-image-to-video", name: "Kling V3.0 Standard I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v3.0-pro-image-to-video", name: "Kling V3.0 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "veo3.1-fast-image-to-video", name: "Veo 3.1 Fast I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.5-image-to-video", name: "WAN 2.5 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.5-image-to-video-fast", name: "WAN 2.5 I2V Fast", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "seedance-v1.5-pro-i2v", name: "Seedance V1.5 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "seedance-v1.5-pro-i2v-fast", name: "Seedance V1.5 Pro I2V Fast", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "minimax-hailuo-02-standard-i2v", name: "Hailuo 02 Standard I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "minimax-hailuo-02-pro-i2v", name: "Hailuo 02 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "vidu-q1-reference", name: "Vidu Q1 Reference", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "pixverse-v5-i2v", name: "PixVerse V5 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "veo3.1-reference-to-video", name: "Veo 3.1 Reference to Video", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "higgsfield-dop-image-to-video", name: "Higgsfield DOP I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.2-spicy-image-to-video", name: "WAN 2.2 Spicy I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "grok-imagine-image-to-video", name: "Grok Imagine I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v2.6-pro-i2v", name: "Kling V2.6 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "minimax-hailuo-2.3-pro-i2v", name: "Hailuo 2.3 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "minimax-hailuo-2.3-standard-i2v", name: "Hailuo 2.3 Standard I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "minimax-hailuo-2.3-fast", name: "Hailuo 2.3 Fast", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "seedance-lite-reference-video", name: "Seedance Lite Reference Video", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-o1-image-to-video", name: "Kling O1 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-o1-reference-to-video", name: "Kling O1 Reference to Video", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "ltx-2-pro-image-to-video", name: "LTX 2 Pro I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "ltx-2-fast-image-to-video", name: "LTX 2 Fast I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "vidu-q2-reference", name: "Vidu Q2 Reference", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "vidu-q2-turbo-start-end-video", name: "Vidu Q2 Turbo Start End Video", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "vidu-q2-pro-start-end-video", name: "Vidu Q2 Pro Start End Video", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.6-image-to-video", name: "WAN 2.6 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "pixverse-v5.5-i2v", name: "PixVerse V5.5 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "wan2.2-speech-to-video", name: "WAN 2.2 Speech to Video", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "ovi-image-to-video", name: "Ovi I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "ltx-2.3-image-to-video", name: "LTX 2.3 I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "ltx-2-19b-image-to-video", name: "LTX 2 19B I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-o1-standard-reference-to-video", name: "Kling O1 Standard Reference to Video", provider: "muapi", capabilities: ["image-to-video"], description: null },

  // ─── Image-to-Image (62 models) ───
  { id: "gpt4o-edit", name: "GPT-4o Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-dress-change", name: "AI Dress Change", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-kontext-max-i2i", name: "Flux Kontext Max I2I", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-image-face-swap", name: "AI Face Swap", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "midjourney-v7-image-to-image", name: "Midjourney V7 I2I", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "midjourney-v7-omni-reference", name: "Midjourney V7 Omni Reference", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "midjourney-v7-style-reference", name: "Midjourney V7 Style Reference", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-background-remover", name: "AI Background Remover", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-color-photo", name: "AI Color Photo", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-image-upscaler", name: "AI Image Upscaler", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-kontext-dev-i2i", name: "Flux Kontext Dev I2I", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-kontext-pro-i2i", name: "Flux Kontext Pro I2I", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "nano-banana-pro-edit", name: "Nano Banana Pro Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-klein-9b-edit", name: "Flux 2 Klein 9B Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-klein-4b-edit", name: "Flux 2 Klein 4B Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-product-shot", name: "AI Product Shot", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-skin-enhancer", name: "AI Skin Enhancer", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-object-eraser", name: "AI Object Eraser", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-image-extension", name: "AI Image Extension", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "gpt4o-image-to-image", name: "GPT-4o Image to Image", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "qwen-image-edit", name: "Qwen Image Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "qwen-image-edit-2511", name: "Qwen Image Edit 2511", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "bytedance-seedream-v5.0-edit", name: "Seedream V5.0 Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "bytedance-seededit-v3", name: "SeedEdit V3", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "nano-banana-edit", name: "Nano Banana Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-redux", name: "Flux Redux", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-pulid", name: "Flux PuLID", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-product-photography", name: "AI Product Photography", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-ghibli-style", name: "AI Ghibli Style", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "add-image-watermark", name: "Add Image Watermark", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ai-captions", name: "AI Captions", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "topaz-image-upscale", name: "Topaz Image Upscale", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "seedvr2-image-upscale", name: "SeedVR2 Image Upscale", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "minimax-image-01-subject-reference", name: "MiniMax Image 01 Subject Reference", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ideogram-character", name: "Ideogram Character", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "ideogram-v3-reframe", name: "Ideogram V3 Reframe", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "bytedance-seedream-v4-edit", name: "Seedream V4 Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "reve-image-edit", name: "Reve Image Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "grok-imagine-image-to-image", name: "Grok Imagine I2I", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "gpt-image-1.5-edit", name: "GPT Image 1.5 Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "wan2.5-image-edit", name: "WAN 2.5 Image Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "wan2.6-image-edit", name: "WAN 2.6 Image Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "qwen-image-edit-plus", name: "Qwen Image Edit Plus", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "qwen-image-edit-plus-lora", name: "Qwen Image Edit Plus LoRA", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-klein-9b-turbo-edit", name: "Flux 2 Klein 9B Turbo Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-klein-4b-turbo-edit", name: "Flux 2 Klein 4B Turbo Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "nano-banana-effects", name: "Nano Banana Effects", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-kontext-effects", name: "Flux Kontext Effects", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "nano-banana-2", name: "Nano Banana 2", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "nano-banana-2-edit", name: "Nano Banana 2 Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "kling-o1-edit-image", name: "Kling O1 Edit Image", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "higgsfield-soul-image-to-image", name: "Higgsfield Soul I2I", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "bytedance-seedream-v4.5-edit", name: "Seedream V4.5 Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-dev-edit", name: "Flux 2 Dev Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-flex-edit", name: "Flux 2 Flex Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "flux-2-pro-edit", name: "Flux 2 Pro Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "vidu-q2-reference-to-image", name: "Vidu Q2 Reference to Image", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "qwen-image-2.0-edit", name: "Qwen Image 2.0 Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "qwen-image-2.0-pro-edit", name: "Qwen Image 2.0 Pro Edit", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "portrait-stylist", name: "Portrait Stylist", provider: "muapi", capabilities: ["image-to-image"], description: null },
  { id: "photo-pack", name: "Photo Pack", provider: "muapi", capabilities: ["image-to-image"], description: null },

  // ─── Video-to-Video (34 models) ───
  { id: "video-combiner", name: "Video Combiner", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ai-video-face-swap", name: "AI Video Face Swap", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "mmaudio-v2-video-to-video", name: "MMAudio V2 V2V", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "heygen-video-translate", name: "HeyGen Video Translate", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ai-clipping", name: "AI Clipping", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "runway-act-two-v2v", name: "Runway Act Two V2V", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "kling-v2.6-std-motion-control", name: "Kling V2.6 Standard Motion Control", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "seedance-v2.0-video-watermark-remover-pro", name: "Seedance V2.0 Video Watermark Remover Pro", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "seedance-v2.0-video-edit", name: "Seedance V2.0 Video Edit", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ai-video-upscaler", name: "AI Video Upscaler", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "runway-aleph-v2v", name: "Runway Aleph V2V", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "sync-lipsync", name: "Sync Lipsync", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "latent-sync", name: "Latent Sync", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "creatify-lipsync", name: "Creatify Lipsync", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "veed-lipsync", name: "VEED Lipsync", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "luma-modify-video", name: "Luma Modify Video", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "luma-flash-reframe", name: "Luma Flash Reframe", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ltx-2-19b-lipsync", name: "LTX 2 19B Lipsync", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "infinitetalk-video-to-video", name: "InfiniteTalk V2V", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ai-dance-effects", name: "AI Dance Effects", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "wan2.2-animate", name: "WAN 2.2 Animate", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "wan2.2-edit-video", name: "WAN 2.2 Edit Video", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "video-watermark-remover", name: "Video Watermark Remover", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "remix-video", name: "Remix Video", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "add-video-watermark", name: "Add Video Watermark", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ai-video-upscaler-pro", name: "AI Video Upscaler Pro", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "kling-o1-video-edit", name: "Kling O1 Video Edit", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "kling-o1-video-edit-fast", name: "Kling O1 Video Edit Fast", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "topaz-video-upscale", name: "Topaz Video Upscale", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "wan2.2-spicy-video-extend", name: "WAN 2.2 Spicy Video Extend", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ltx-2.3-lipsync", name: "LTX 2.3 Lipsync", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "ltx-2.3-video-extend", name: "LTX 2.3 Video Extend", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "kling-v3.0-std-motion-control", name: "Kling V3.0 Standard Motion Control", provider: "muapi", capabilities: ["video-to-video"], description: null },
  { id: "kling-v3.0-pro-motion-control", name: "Kling V3.0 Pro Motion Control", provider: "muapi", capabilities: ["video-to-video"], description: null },

  // ─── Text-to-Audio (11 models) ───
  { id: "suno-remix-music", name: "Suno Remix Music", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "suno-create-music", name: "Suno Create Music", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "suno-extend-music", name: "Suno Extend Music", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "suno-add-vocals", name: "Suno Add Vocals", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "suno-add-instrumental", name: "Suno Add Instrumental", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "mmaudio-v2-text-to-audio", name: "MMAudio V2 T2A", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "suno-generate-sounds", name: "Suno Generate Sounds", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "minimax-voice-clone", name: "MiniMax Voice Clone", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "minimax-speech-2.6-hd", name: "MiniMax Speech 2.6 HD", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "minimax-speech-2.6-turbo", name: "MiniMax Speech 2.6 Turbo", provider: "muapi", capabilities: ["text-to-audio"], description: null },
  { id: "suno-generate-lyrics", name: "Suno Generate Lyrics", provider: "muapi", capabilities: ["text-to-audio"], description: null },

  // ─── Audio-to-Video / Avatar (5 models, excluding lipsync dupes in v2v) ───
  { id: "kling-v2-avatar-pro", name: "Kling V2 Avatar Pro", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v1-avatar-standard", name: "Kling V1 Avatar Standard", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v1-avatar-pro", name: "Kling V1 Avatar Pro", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "kling-v2-avatar-standard", name: "Kling V2 Avatar Standard", provider: "muapi", capabilities: ["image-to-video"], description: null },
  { id: "infinitetalk-image-to-video", name: "InfiniteTalk I2V", provider: "muapi", capabilities: ["image-to-video"], description: null },
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
