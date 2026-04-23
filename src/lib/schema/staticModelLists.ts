/**
 * Static model ID lists used by the warmer.
 *
 * These mirror the hand-written model catalogs in src/app/api/models/route.ts
 * (KIE_MODELS and GEMINI_IMAGE/VIDEO_MODELS), but only expose the id field —
 * that's all the warmer needs to drive extraction.
 *
 * If you add a model to the route's catalog, add its id here too.
 */

export const KIE_MODELS_LIST: string[] = [
  // Image
  "z-image",
  "seedream/4.5-text-to-image",
  "seedream/4.5-edit",
  "gpt-image/1.5-text-to-image",
  "gpt-image/1.5-image-to-image",
  "flux-2/pro-text-to-image",
  "flux-2/pro-image-to-image",
  "flux-2/flex-text-to-image",
  "flux-2/flex-image-to-image",
  "nano-banana-pro",
  "grok-imagine/text-to-image",
  "grok-imagine/image-to-image",
  // Video
  "grok-imagine/text-to-video",
  "grok-imagine/image-to-video",
  "kling-2.6/text-to-video",
  "kling-2.6/image-to-video",
  "kling-2.6/motion-control",
  "kling/v2-5-turbo-text-to-video-pro",
  "kling/v2-5-turbo-image-to-video-pro",
  "wan/2-6-text-to-video",
  "wan/2-6-image-to-video",
  "wan/2-6-video-to-video",
  "runway/aleph-video-to-video",
  "luma/modify-video",
  "topaz/video-upscale",
  "veo3/text-to-video",
  "veo3/image-to-video",
  "veo3-fast/text-to-video",
  "veo3-fast/image-to-video",
  // Audio / TTS
  "elevenlabs/turbo-v2.5",
  "elevenlabs/multilingual-v2",
  "elevenlabs/text-to-dialogue-v3",
  "elevenlabs/sound-effect-v2",
];

export const GEMINI_MODELS_LIST: string[] = [
  "nano-banana",
  "nano-banana-2",
  "nano-banana-pro",
  "veo-3.1/text-to-video",
  "veo-3.1/image-to-video",
  "veo-3.1-fast/text-to-video",
  "veo-3.1-fast/image-to-video",
];
