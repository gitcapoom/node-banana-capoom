import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { LLMGenerateRequest, LLMGenerateResponse, LLMModelType, ConversationTurn } from "@/types";
import { logger } from "@/utils/logger";
import { compressImage } from "@/app/api/generate/utils/imageCompression";

export const maxDuration = 60; // 1 minute timeout

// Generate a unique request ID for tracking
function generateRequestId(): string {
  return `llm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Legacy alias maps. Older workflows stored friendly slugs (e.g.
// "claude-sonnet-4.5") that don't match the provider's canonical model ID
// (e.g. "claude-sonnet-4-5-20250929"). New workflows store the canonical
// ID directly because the LLM node now fetches `/api/llm/models` and
// populates its dropdown from each provider's `models` endpoint. These
// maps stay as a fallback so existing saved workflows keep working — if
// a model lookup misses, we pass the value through unchanged.
const GOOGLE_MODEL_ALIASES: Record<string, string> = {};
const OPENAI_MODEL_ALIASES: Record<string, string> = {};
const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4.5": "claude-sonnet-4-5-20250929",
  "claude-haiku-4.5": "claude-haiku-4-5-20251001",
  "claude-opus-4.6": "claude-opus-4-6",
};

function resolveModel(aliases: Record<string, string>, model: string): string {
  return aliases[model] ?? model;
}

/**
 * Per-provider hard limits for inline image payloads (data URLs, decoded
 * to raw bytes). Larger images get auto-compressed via `compressImage`
 * before hitting the wire. Numbers are the providers' documented limits:
 *
 *   Anthropic: 5 MB per image (vision spec)
 *   OpenAI:    20 MB per image (chat completions vision)
 *   Google:    20 MB per inline blob (Gemini inlineData spec)
 *
 * We compress AT the limit (not just over it) so a marginal image
 * doesn't sit right at the threshold and trip transport-side variation.
 */
const PROVIDER_IMAGE_LIMITS = {
  anthropic: 5 * 1024 * 1024,
  openai: 20 * 1024 * 1024,
  google: 20 * 1024 * 1024,
} as const;

/**
 * If a base64 image data URL exceeds the given byte limit, run it through
 * the shared `compressImage` (PNG→JPEG, then optional 50% resize).
 * Non-data URLs and already-small images pass through unchanged.
 */
async function enforceImageSize(img: string, limitBytes: number, providerLabel: string): Promise<string> {
  if (!img.startsWith("data:")) return img;
  const match = img.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return img;
  const rawSize = Math.ceil(match[2].length * 3 / 4);
  if (rawSize <= limitBytes) return img;
  console.log(`[LLM/${providerLabel}] Image ${(rawSize / 1024 / 1024).toFixed(1)}MB exceeds ${(limitBytes / 1024 / 1024).toFixed(0)}MB limit, compressing...`);
  return await compressImage(img);
}

/**
 * Inspect the leading bytes of base64-encoded image data and return its
 * actual MIME type. Upstream nodes sometimes label a PNG as
 * `image/jpeg` (or worse, default everything to PNG) — OpenAI rejects
 * mismatched URLs as "Invalid image", and Anthropic's base64 source
 * blocks need an accurate `media_type`. Falls back to the caller-provided
 * default if the magic bytes are unrecognised.
 */
function detectImageMimeFromBase64(base64Data: string, fallback: string): string {
  try {
    const firstBytes = Buffer.from(base64Data.substring(0, 16), "base64");
    if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8) return "image/jpeg";
    if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47) return "image/png";
    if (firstBytes[0] === 0x52 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46 && firstBytes[3] === 0x46) return "image/webp";
    if (firstBytes[0] === 0x47 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) return "image/gif";
  } catch { /* keep declared mediaType on decode failure */ }
  return fallback;
}

/**
 * Rebuild an image data URL with the correct MIME type detected from
 * magic bytes. Non-data URLs (http/https/blob) pass through unchanged
 * because the wire format is provider-agnostic.
 */
function normalizeImageDataUrl(img: string): string {
  if (!img.startsWith("data:")) return img;
  const matches = img.match(/^data:(.+?);base64,(.+)$/);
  if (!matches) return img;
  const declared = matches[1];
  const base64Data = matches[2];
  const actual = detectImageMimeFromBase64(base64Data, declared);
  return actual === declared ? img : `data:${actual};base64,${base64Data}`;
}

/** Convert a data URL to Gemini's inlineData part shape. */
function googleImagePart(img: string): { inlineData: { mimeType: string; data: string } } {
  const normalized = normalizeImageDataUrl(img);
  const matches = normalized.match(/^data:(.+?);base64,(.+)$/);
  if (matches) {
    return { inlineData: { mimeType: matches[1], data: matches[2] } };
  }
  // Fallback: assume PNG if no data URL prefix
  return { inlineData: { mimeType: "image/png", data: normalized } };
}

type GooglePart = { inlineData: { mimeType: string; data: string } } | { text: string };
type GoogleContent = { role: "user" | "model"; parts: GooglePart[] };

// ─── Reasoning / thinking ─────────────────────────────────────────
// Cross-provider dial-up for "think more before answering". Each
// provider exposes a different native parameter — we map a single
// off/low/medium/high level to whichever shape applies.

export type ReasoningLevel = "off" | "low" | "medium" | "high";

/**
 * Does this provider+model accept a reasoning/thinking parameter?
 * Reasoning-era models (o1+, GPT-5+, Claude 3.7 Sonnet / 4+, Gemini 2.5+)
 * do; everything else either ignores it or returns 400.
 */
function supportsReasoning(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === "openai") {
    // o1/o3/o4 family + GPT-5 family.
    return /^o[134](-|$)/.test(m) || /^gpt-5/.test(m);
  }
  if (provider === "anthropic") {
    // Claude 3.7 Sonnet, all Claude 4.x+ (Opus / Sonnet / Haiku).
    return /^claude-3-7-sonnet/.test(m) || /^claude-(opus|sonnet|haiku)-[4-9]/.test(m);
  }
  if (provider === "google") {
    if (!/^gemini-(2\.5|3)/.test(m)) return false;
    // The image-gen and TTS Gemini variants don't expose thinkingConfig.
    if (/-image\b/.test(m) || /-tts\b/.test(m)) return false;
    return true;
  }
  return false;
}

/** Anthropic `thinking.budget_tokens`. Higher = deeper reasoning, costs
 *  more output tokens. Note: the budget is *subtracted* from max_tokens,
 *  so users dialing this up may need to bump Max Tokens too. */
function anthropicThinkingBudget(level: ReasoningLevel): number {
  switch (level) {
    case "low": return 2048;
    case "medium": return 8192;
    case "high": return 16384;
    default: return 0;
  }
}

/** OpenAI's `reasoning_effort`. "minimal" is opt-out-style on GPT-5;
 *  we treat "off" as omit so the provider uses its default rather than
 *  silently weakening quality. */
function openaiReasoningEffort(level: ReasoningLevel): "low" | "medium" | "high" | null {
  return level === "off" ? null : level;
}

/** Google `thinkingConfig.thinkingBudget`. -1 = let the model decide. */
function geminiThinkingBudget(level: ReasoningLevel): number {
  switch (level) {
    case "low": return 1024;
    case "medium": return -1;
    case "high": return 8192;
    default: return 0;
  }
}

async function generateWithGoogle(
  messages: ConversationTurn[],
  system: string | undefined,
  model: LLMModelType,
  temperature: number,
  maxTokens: number,
  reasoning: ReasoningLevel,
  requestId?: string,
  userApiKey?: string | null
): Promise<string> {
  // User-provided key takes precedence over env variable
  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.error('api.error', 'GEMINI_API_KEY not configured', { requestId });
    throw new Error("GEMINI_API_KEY not configured. Add it to .env.local or configure in Settings.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const modelId = resolveModel(GOOGLE_MODEL_ALIASES, model);

  const totalImages = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  const totalTextLen = messages.reduce((n, m) => n + m.text.length, 0);
  logger.info('api.llm', 'Calling Google AI API', {
    requestId,
    model: modelId,
    temperature,
    maxTokens,
    turns: messages.length,
    imageCount: totalImages,
    promptLength: totalTextLen,
    hasSystem: !!system,
  });

  // Translate turns into Gemini's `contents` array. Assistant role is
  // `model` in Gemini parlance. Each turn's images become inlineData parts
  // followed by a text part. Async because oversized images go through
  // sharp-based compression before encoding.
  const contents: GoogleContent[] = [];
  for (const m of messages) {
    const parts: GooglePart[] = [];
    if (m.images && m.images.length > 0) {
      for (const img of m.images) {
        const sized = await enforceImageSize(img, PROVIDER_IMAGE_LIMITS.google, "google");
        parts.push(googleImagePart(sized));
      }
    }
    parts.push({ text: m.text });
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }

  // Reasoning: Gemini 2.5+ thinking variants accept a thinkingConfig.
  // -1 means "let the model decide" (dynamic budget). Skip the field
  // entirely for off so unsupported models don't 400.
  const useReasoning = reasoning !== "off" && supportsReasoning("google", modelId);
  const thinkingBudget = useReasoning ? geminiThinkingBudget(reasoning) : null;

  const startTime = Date.now();
  const response = await ai.models.generateContent({
    model: modelId,
    contents,
    config: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(thinkingBudget !== null ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  });
  const duration = Date.now() - startTime;

  // Use the convenient .text property that concatenates all text parts
  const text = response.text;
  if (!text) {
    logger.error('api.error', 'No text in Google AI response', { requestId });
    throw new Error("No text in Google AI response");
  }

  logger.info('api.llm', 'Google AI API response received', {
    requestId,
    duration,
    responseLength: text.length,
  });

  return text;
}

type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentBlock[];
};

async function generateWithOpenAI(
  messages: ConversationTurn[],
  system: string | undefined,
  model: LLMModelType,
  temperature: number,
  maxTokens: number,
  reasoning: ReasoningLevel,
  requestId?: string,
  userApiKey?: string | null
): Promise<string> {
  // User-provided key takes precedence over env variable
  const apiKey = userApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error('api.error', 'OPENAI_API_KEY not configured', { requestId });
    throw new Error("OPENAI_API_KEY not configured. Add it to .env.local or configure in Settings.");
  }

  const modelId = resolveModel(OPENAI_MODEL_ALIASES, model);

  const totalImages = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  const totalTextLen = messages.reduce((n, m) => n + m.text.length, 0);
  logger.info('api.llm', 'Calling OpenAI API', {
    requestId,
    model: modelId,
    temperature,
    maxTokens,
    turns: messages.length,
    imageCount: totalImages,
    promptLength: totalTextLen,
    hasSystem: !!system,
  });

  // Translate turns into chat-completions messages. System goes as a
  // dedicated system message at the head. Images attach to user turns as
  // vision content blocks; assistant turns are always plain strings.
  const apiMessages: OpenAIMessage[] = [];
  if (system) apiMessages.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user" && m.images && m.images.length > 0) {
      // First cap size (OpenAI: 20 MB / image), then normalise the data
      // URL MIME so the prefix matches the actual bytes. Upstream nodes
      // frequently mis-label PNG bytes as JPEG or vice versa, and OpenAI
      // rejects mismatched URLs as "Invalid image".
      const imageBlocks: OpenAIContentBlock[] = [];
      for (const img of m.images) {
        const sized = await enforceImageSize(img, PROVIDER_IMAGE_LIMITS.openai, "openai");
        imageBlocks.push({
          type: "image_url",
          // "high" makes OpenAI tile the image at full resolution instead of
          // the coarse "auto"/low pass — needed for judging fine texture,
          // color, and micro-detail (loopback Assess relies on this).
          image_url: { url: normalizeImageDataUrl(sized), detail: "high" },
        });
      }
      apiMessages.push({
        role: "user",
        content: [{ type: "text", text: m.text }, ...imageBlocks],
      });
    } else {
      apiMessages.push({ role: m.role, content: m.text });
    }
  }

  // Reasoning: o1/o3/o4/GPT-5 family accept `reasoning_effort`. For all
  // other OpenAI models the field is silently ignored — but we still
  // gate on supportsReasoning so the wire payload stays clean.
  const effort = reasoning !== "off" && supportsReasoning("openai", modelId)
    ? openaiReasoningEffort(reasoning)
    : null;

  const startTime = Date.now();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: apiMessages,
      temperature,
      // GPT-5+ and o1/o3/o4 reject `max_tokens` ("Use 'max_completion_tokens'
      // instead"). `max_completion_tokens` is supported across the entire
      // current chat-completions family, so we use it universally.
      max_completion_tokens: maxTokens,
      ...(effort ? { reasoning_effort: effort } : {}),
    }),
  });
  const duration = Date.now() - startTime;

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    logger.error('api.error', 'OpenAI API request failed', {
      requestId,
      status: response.status,
      error: error.error?.message,
    });
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;

  if (!text) {
    logger.error('api.error', 'No text in OpenAI response', { requestId });
    throw new Error("No text in OpenAI response");
  }

  logger.info('api.llm', 'OpenAI API response received', {
    requestId,
    duration,
    responseLength: text.length,
  });

  return text;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

/**
 * Anthropic's "thinking-era" Opus models (Opus 4.5 onward and any Opus 5+)
 * reject explicit `temperature` — the API returns 400 with
 * "`temperature` is deprecated for this model." Everything earlier
 * (Sonnet/Haiku across all generations, Opus 4 / 4.1) still accepts it.
 */
function anthropicAcceptsTemperature(model: string): boolean {
  if (/^claude-opus-4-[5-9]/.test(model)) return false;
  if (/^claude-opus-(\d{2,}|[5-9])/.test(model)) return false;
  return true;
}

/** Convert a (possibly oversized) data URL into Anthropic's image block. */
async function anthropicImageBlock(imgArg: string): Promise<AnthropicContentBlock> {
  const img = await enforceImageSize(imgArg, PROVIDER_IMAGE_LIMITS.anthropic, "anthropic");
  const matches = img.match(/^data:(.+?);base64,(.+)$/);
  const base64Data = matches ? matches[2] : img;
  const declared = matches ? matches[1] : "image/png";
  const mediaType = detectImageMimeFromBase64(base64Data, declared);
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: base64Data },
  };
}

async function generateWithAnthropic(
  messages: ConversationTurn[],
  system: string | undefined,
  model: LLMModelType,
  temperature: number,
  maxTokens: number,
  reasoning: ReasoningLevel,
  requestId?: string,
  userApiKey?: string | null
): Promise<string> {
  const apiKey = userApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('api.error', 'ANTHROPIC_API_KEY not configured', { requestId });
    throw new Error("ANTHROPIC_API_KEY not configured. Add it to .env.local or configure in Settings.");
  }

  const modelId = resolveModel(ANTHROPIC_MODEL_ALIASES, model);

  const totalImages = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  const totalTextLen = messages.reduce((n, m) => n + m.text.length, 0);
  logger.info('api.llm', 'Calling Anthropic API', {
    requestId,
    model: modelId,
    temperature,
    maxTokens,
    turns: messages.length,
    imageCount: totalImages,
    promptLength: totalTextLen,
    hasSystem: !!system,
  });

  // Build the Anthropic messages array. System lives on the top-level
  // `system` field, not in the messages array. Images attach to user
  // turns only and come BEFORE the text in the block list (Anthropic's
  // recommended ordering for vision).
  const apiMessages: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.images && m.images.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      for (const img of m.images) {
        blocks.push(await anthropicImageBlock(img));
      }
      blocks.push({ type: "text", text: m.text });
      apiMessages.push({ role: "user", content: blocks });
    } else {
      apiMessages.push({ role: m.role, content: m.text });
    }
  }

  // Reasoning: extended thinking. Anthropic requires temperature to be
  // omitted (or =1) whenever thinking is enabled, AND the thinking
  // budget is *deducted from* max_tokens — so we need to ensure the
  // budget fits with headroom for the actual reply.
  const useReasoning = reasoning !== "off" && supportsReasoning("anthropic", modelId);
  const thinkBudget = useReasoning ? anthropicThinkingBudget(reasoning) : 0;
  // Reserve at least 1024 tokens for the visible reply on top of thinking;
  // bump max_tokens automatically if the user's slider would leave no room.
  const effectiveMaxTokens = thinkBudget > 0
    ? Math.max(maxTokens, thinkBudget + 1024)
    : maxTokens;
  const tempForRequest = thinkBudget > 0
    ? null
    : (anthropicAcceptsTemperature(modelId) ? temperature : null);

  const startTime = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      messages: apiMessages,
      ...(tempForRequest !== null ? { temperature: tempForRequest } : {}),
      max_tokens: effectiveMaxTokens,
      ...(system ? { system } : {}),
      ...(thinkBudget > 0 ? { thinking: { type: "enabled", budget_tokens: thinkBudget } } : {}),
    }),
  });
  const duration = Date.now() - startTime;

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    logger.error('api.error', 'Anthropic API request failed', {
      requestId,
      status: response.status,
      error: error.error?.message,
    });
    throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  // With extended thinking the response array starts with `thinking`
  // blocks; find the first text block instead of blindly grabbing [0].
  type AnthropicResponseBlock = { type: string; text?: string };
  const blocks: AnthropicResponseBlock[] = Array.isArray(data.content) ? data.content : [];
  const textBlock = blocks.find((b) => b.type === "text" && typeof b.text === "string");
  const text = textBlock?.text;

  if (!text) {
    logger.error('api.error', 'No text in Anthropic response', { requestId });
    throw new Error("No text in Anthropic response");
  }

  logger.info('api.llm', 'Anthropic API response received', {
    requestId,
    duration,
    responseLength: text.length,
  });

  return text;
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();

  try {
    // Get user-provided API keys from headers (override env variables)
    const geminiApiKey = request.headers.get("X-Gemini-API-Key");
    const openaiApiKey = request.headers.get("X-OpenAI-API-Key");
    const anthropicApiKey = request.headers.get("X-Anthropic-API-Key");

    const body: LLMGenerateRequest = await request.json();
    const {
      prompt,
      images,
      messages,
      system,
      provider,
      model,
      temperature = 0.7,
      maxTokens = 1024,
      reasoning = "off",
    } = body;

    // Normalise to a single internal shape (`messages[]`). New multi-turn
    // callers populate `messages` directly; legacy one-shot callers pass
    // `prompt`/`images` and we wrap them into a single user turn.
    let normMessages: ConversationTurn[];
    if (Array.isArray(messages) && messages.length > 0) {
      normMessages = messages;
    } else if (prompt) {
      normMessages = [{ role: "user", text: prompt, ...(images && images.length > 0 ? { images } : {}) }];
    } else {
      logger.warn('api.llm', 'LLM request validation failed: no prompt or messages', { requestId });
      return NextResponse.json<LLMGenerateResponse>(
        { success: false, error: "Prompt or messages are required" },
        { status: 400 }
      );
    }

    // Strip image entries that don't look like an image URL — protects
    // against text-typed sources being wired to the image handle upstream
    // (React Flow doesn't enforce handle-type matching on edges).
    const isLikelyImageUrl = (s: unknown): s is string => {
      if (typeof s !== "string" || s.length === 0) return false;
      return s.startsWith("data:image/") || s.startsWith("http://") || s.startsWith("https://") || s.startsWith("blob:");
    };
    normMessages = normMessages.map((m) => {
      if (!m.images || m.images.length === 0) return m;
      const valid = m.images.filter(isLikelyImageUrl);
      return valid.length === m.images.length ? m : { ...m, images: valid };
    });

    const totalImages = normMessages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    logger.info('api.llm', 'LLM generation request received', {
      requestId,
      provider,
      model,
      temperature,
      maxTokens,
      turns: normMessages.length,
      hasImages: totalImages > 0,
      imageCount: totalImages,
      hasSystem: !!system,
    });

    let text: string;

    if (provider === "google") {
      text = await generateWithGoogle(normMessages, system, model, temperature, maxTokens, reasoning, requestId, geminiApiKey);
    } else if (provider === "openai") {
      text = await generateWithOpenAI(normMessages, system, model, temperature, maxTokens, reasoning, requestId, openaiApiKey);
    } else if (provider === "anthropic") {
      text = await generateWithAnthropic(normMessages, system, model, temperature, maxTokens, reasoning, requestId, anthropicApiKey);
    } else {
      logger.warn('api.llm', 'Unknown provider requested', { requestId, provider });
      return NextResponse.json<LLMGenerateResponse>(
        { success: false, error: `Unknown provider: ${provider}` },
        { status: 400 }
      );
    }

    logger.info('api.llm', 'LLM generation successful', {
      requestId,
      responseLength: text.length,
    });

    return NextResponse.json<LLMGenerateResponse>({
      success: true,
      text,
    });
  } catch (error) {
    logger.error('api.error', 'LLM generation error', { requestId }, error instanceof Error ? error : undefined);

    // Handle rate limiting
    if (error instanceof Error && error.message.includes("429")) {
      return NextResponse.json<LLMGenerateResponse>(
        { success: false, error: "Rate limit reached. Please wait and try again." },
        { status: 429 }
      );
    }

    return NextResponse.json<LLMGenerateResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : "LLM generation failed",
      },
      { status: 500 }
    );
  }
}
