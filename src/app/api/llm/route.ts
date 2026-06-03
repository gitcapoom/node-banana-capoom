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

/** Convert a data URL to Gemini's inlineData part shape. */
function googleImagePart(img: string): { inlineData: { mimeType: string; data: string } } {
  const matches = img.match(/^data:(.+?);base64,(.+)$/);
  if (matches) {
    return { inlineData: { mimeType: matches[1], data: matches[2] } };
  }
  // Fallback: assume PNG if no data URL prefix
  return { inlineData: { mimeType: "image/png", data: img } };
}

type GooglePart = { inlineData: { mimeType: string; data: string } } | { text: string };
type GoogleContent = { role: "user" | "model"; parts: GooglePart[] };

async function generateWithGoogle(
  messages: ConversationTurn[],
  system: string | undefined,
  model: LLMModelType,
  temperature: number,
  maxTokens: number,
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
  // followed by a text part.
  const contents: GoogleContent[] = messages.map((m) => {
    const parts: GooglePart[] = [];
    if (m.images && m.images.length > 0) {
      for (const img of m.images) parts.push(googleImagePart(img));
    }
    parts.push({ text: m.text });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });

  const startTime = Date.now();
  const response = await ai.models.generateContent({
    model: modelId,
    contents,
    config: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
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
  | { type: "image_url"; image_url: { url: string } };
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
      const content: OpenAIContentBlock[] = [
        { type: "text", text: m.text },
        ...m.images.map((img) => ({ type: "image_url" as const, image_url: { url: img } })),
      ];
      apiMessages.push({ role: "user", content });
    } else {
      apiMessages.push({ role: m.role, content: m.text });
    }
  }

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
      max_tokens: maxTokens,
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

const ANTHROPIC_IMAGE_LIMIT = 5 * 1024 * 1024; // 5 MB

/** Convert a (possibly oversized) data URL into Anthropic's image block. */
async function anthropicImageBlock(imgArg: string): Promise<AnthropicContentBlock> {
  let img = imgArg;
  // Proactively compress images that exceed Anthropic's 5MB limit
  const rawMatch = img.match(/^data:(.+?);base64,(.+)$/);
  const rawSize = rawMatch ? Math.ceil(rawMatch[2].length * 3 / 4) : 0;
  if (rawSize > ANTHROPIC_IMAGE_LIMIT) {
    console.log(`[LLM] Image ${(rawSize / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit, compressing...`);
    img = await compressImage(img);
  }
  const matches = img.match(/^data:(.+?);base64,(.+)$/);
  const base64Data = matches ? matches[2] : img;
  let mediaType = matches ? matches[1] : "image/png";

  // Detect actual image type from magic bytes (data URL mime is often wrong)
  try {
    const firstBytes = Buffer.from(base64Data.substring(0, 16), "base64");
    if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8) mediaType = "image/jpeg";
    else if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47) mediaType = "image/png";
    else if (firstBytes[0] === 0x52 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46 && firstBytes[3] === 0x46) mediaType = "image/webp";
    else if (firstBytes[0] === 0x47 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) mediaType = "image/gif";
  } catch { /* keep declared mediaType */ }

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
      temperature,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
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
  const text = data.content?.[0]?.text;

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
      maxTokens = 1024
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
      text = await generateWithGoogle(normMessages, system, model, temperature, maxTokens, requestId, geminiApiKey);
    } else if (provider === "openai") {
      text = await generateWithOpenAI(normMessages, system, model, temperature, maxTokens, requestId, openaiApiKey);
    } else if (provider === "anthropic") {
      text = await generateWithAnthropic(normMessages, system, model, temperature, maxTokens, requestId, anthropicApiKey);
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
