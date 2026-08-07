/**
 * API Types
 *
 * Request and response types for API routes including
 * image generation and LLM text generation.
 */

import type { AspectRatio, Resolution, ModelType } from "./models";
import type { LLMProvider, LLMModelType } from "./providers";

// API Request/Response types for Image Generation
export interface GenerateRequest {
  images: string[]; // Now supports multiple images
  prompt: string;
  aspectRatio?: AspectRatio;
  resolution?: Resolution; // Only for Nano Banana Pro
  model?: ModelType;
  useGoogleSearch?: boolean; // Only for Nano Banana Pro and Nano Banana 2
  useImageSearch?: boolean; // Only for Nano Banana 2
  mediaType?: "image" | "video" | "3d" | "audio"; // Indicates expected output type for provider routing
}

export interface GenerateResponse {
  success: boolean;
  image?: string;
  /** Multiple images returned (e.g., num_images > 1). First image is in `image` for back-compat. */
  images?: string[];
  video?: string;
  videoUrl?: string; // For large videos, return URL directly
  audio?: string; // Base64 audio data
  audioUrl?: string; // For large audio, return URL directly
  model3dUrl?: string; // For 3D models, return GLB URL directly
  contentType?: "image" | "video" | "3d" | "audio";
  error?: string;
  cost?: number; // Generation cost in USD (from provider pricing)
}

// One entry in a multi-turn LLM conversation. `system` lives separately
// on the request (the providers carry it in their own slot — OpenAI as a
// `system` message, Anthropic as a top-level field, Gemini as
// `systemInstruction`), so the array only carries user/assistant turns.
// Images attach to user turns only.
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  /** Video data/http URLs. Only Google Gemini models accept video input;
   *  the route rejects videos on other providers with a clear error. */
  videos?: string[];
  /** ms epoch — used for sort stability in the UI, optional everywhere else. */
  timestamp?: number;
}

// API Request/Response types for LLM Text Generation.
//
// Two shapes are supported on the same endpoint:
//   - Legacy single-shot: { prompt, images?, ... }  — current behaviour.
//   - Conversation:       { messages, system?, ... }  — multi-turn.
// When `messages` is present and non-empty, the route uses the multi-turn
// path and ignores `prompt`/`images`. Otherwise the legacy fields are
// translated into a single user turn internally.
export interface LLMGenerateRequest {
  prompt?: string;
  images?: string[];
  /** Video inputs (Gemini models only). */
  videos?: string[];
  messages?: ConversationTurn[];
  system?: string;
  provider: LLMProvider;
  model: LLMModelType;
  temperature?: number;
  maxTokens?: number;
  /** Provider-agnostic reasoning / thinking effort. The route translates
   *  this into each provider's native param: Anthropic adaptive thinking +
   *  `output_config.effort` (older Claude models: `thinking.budget_tokens`),
   *  OpenAI `reasoning_effort`, Google `thinkingConfig.thinkingBudget`. */
  reasoning?: "off" | "low" | "medium" | "high";
}

export interface LLMGenerateResponse {
  success: boolean;
  text?: string;
  error?: string;
}
