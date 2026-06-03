/**
 * GET /api/llm/models
 *
 * Returns the per-provider list of LLM models currently available. Each
 * provider exposes a public `models` endpoint that can be hit with the
 * same API key used for generation:
 *
 *   - Google (Gemini):  https://generativelanguage.googleapis.com/v1beta/models?key=…
 *   - OpenAI:           https://api.openai.com/v1/models       (Bearer)
 *   - Anthropic:        https://api.anthropic.com/v1/models    (x-api-key)
 *
 * Per-provider failures (missing key, rate limit, network) are reported
 * inline in `errors` so the UI can still render the other providers.
 * Server-side env keys are used if the request didn't carry one.
 *
 * Filtering rules:
 *   - Google: keep models that list `generateContent` in
 *     `supportedGenerationMethods` — that's the chat endpoint our
 *     `/api/llm` route uses.
 *   - OpenAI: keep `gpt-*` and reasoning models (`o1*`, `o3*`, `o4*`).
 *     Drop embeddings / audio / vision-only / image / search / etc.
 *   - Anthropic: keep all — every model the endpoint returns is a chat
 *     model.
 *
 * Results are returned newest-first within each provider when the source
 * exposes a created timestamp.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface ModelEntry {
  /** Canonical model ID to pass to /api/llm (matches the provider's API). */
  id: string;
  /** Human-readable label for the dropdown. */
  label: string;
}

export interface LlmModelsResponse {
  google: ModelEntry[];
  openai: ModelEntry[];
  anthropic: ModelEntry[];
  /** Per-provider error strings when a fetch failed (missing key, 429, etc.). */
  errors: Partial<Record<"google" | "openai" | "anthropic", string>>;
}

/** Human-readable label generator for raw IDs (when the source has no display name). */
function prettyLabel(id: string): string {
  // "gemini-2.5-flash" → "Gemini 2.5 Flash"
  // "gpt-4.1-mini" → "GPT 4.1 Mini"
  // "claude-sonnet-4-5-20250929" → "Claude Sonnet 4 5 20250929"
  return id
    .split(/[-_]/)
    .map((w) => (/^gpt$/i.test(w) ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

async function fetchGoogle(apiKey: string): Promise<ModelEntry[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google models: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  type GoogleModel = { name?: string; displayName?: string; supportedGenerationMethods?: string[] };
  const models: GoogleModel[] = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => {
      // "models/gemini-2.5-flash" → "gemini-2.5-flash"
      const rawName = m.name || "";
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      return { id, label: m.displayName || prettyLabel(id) };
    })
    .filter((m) => m.id.length > 0);
}

async function fetchOpenAI(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI models: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  type OpenAIModel = { id: string; created?: number };
  const all: OpenAIModel[] = Array.isArray(data?.data) ? data.data : [];

  // Heuristic filter — the /v1/models endpoint returns embeddings, audio,
  // image, moderation, completions-only, and other non-chat models too.
  // Keep only models we can plausibly send to /v1/chat/completions.
  //
  // - `instruct` is the legacy v1/completions endpoint family
  //   (e.g. gpt-3.5-turbo-instruct) — separate endpoint, not chat.
  const KEEP = /^(gpt-|o[134])/i;
  const DROP_KIND = /(embed|moderation|whisper|tts|realtime|audio|transcribe|search|image|dall-e|babbage|davinci|moonshine|instruct)/i;

  // Trim the dropdown to flat canonical names only — hide:
  //   `-pro$` / `-pro-…`     → Pro tier (separate research endpoint and/or
  //                            chat-completions incompatible: gpt-5-pro,
  //                            gpt-5.5-pro-2026-04-23, o1-pro, o3-pro, …)
  //   `-YYYY-MM-DD$`         → dated snapshots (gpt-5.5-2026-04-23, …)
  //   `-DDDD$`               → compact dated snapshots (gpt-4-0613, …)
  // Leaves gpt-5.5, gpt-5.5-mini, gpt-5.5-nano, gpt-4o, gpt-4o-mini, o3,
  // o3-mini, o4-mini, o1, gpt-4.1, gpt-4-turbo, gpt-3.5-turbo, etc.
  const DROP_VARIANT = /(-pro$|-pro-|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/i;

  return all
    .filter((m) => KEEP.test(m.id) && !DROP_KIND.test(m.id) && !DROP_VARIANT.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({ id: m.id, label: prettyLabel(m.id) }));
}

async function fetchAnthropic(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic models: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  type AnthropicModel = { id: string; display_name?: string; created_at?: string };
  const all: AnthropicModel[] = Array.isArray(data?.data) ? data.data : [];
  return all
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((m) => ({ id: m.id, label: m.display_name || prettyLabel(m.id) }));
}

export async function GET(request: NextRequest): Promise<NextResponse<LlmModelsResponse>> {
  const googleKey = request.headers.get("X-Gemini-API-Key") || process.env.GEMINI_API_KEY || "";
  const openaiKey = request.headers.get("X-OpenAI-API-Key") || process.env.OPENAI_API_KEY || "";
  const anthropicKey = request.headers.get("X-Anthropic-API-Key") || process.env.ANTHROPIC_API_KEY || "";

  const result: LlmModelsResponse = {
    google: [],
    openai: [],
    anthropic: [],
    errors: {},
  };

  // Fan out in parallel — one slow provider shouldn't block the others.
  const tasks: Array<Promise<void>> = [];

  if (googleKey) {
    tasks.push(
      fetchGoogle(googleKey)
        .then((models) => { result.google = models; })
        .catch((err) => { result.errors.google = err instanceof Error ? err.message : String(err); }),
    );
  } else {
    result.errors.google = "Missing GEMINI_API_KEY";
  }

  if (openaiKey) {
    tasks.push(
      fetchOpenAI(openaiKey)
        .then((models) => { result.openai = models; })
        .catch((err) => { result.errors.openai = err instanceof Error ? err.message : String(err); }),
    );
  } else {
    result.errors.openai = "Missing OPENAI_API_KEY";
  }

  if (anthropicKey) {
    tasks.push(
      fetchAnthropic(anthropicKey)
        .then((models) => { result.anthropic = models; })
        .catch((err) => { result.errors.anthropic = err instanceof Error ? err.message : String(err); }),
    );
  } else {
    result.errors.anthropic = "Missing ANTHROPIC_API_KEY";
  }

  await Promise.all(tasks);

  return NextResponse.json(result, {
    headers: {
      // Short cache so a hot reload doesn't re-hit the providers, but new
      // model launches show up within a few minutes.
      "Cache-Control": "private, max-age=300",
    },
  });
}
