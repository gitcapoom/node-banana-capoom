/**
 * Model Schema API Endpoint.
 *
 * Thin wrapper over the unified schema library (`src/lib/schema/`):
 *   1. Try reading the precomputed disk cache — the warmer refreshes every
 *      24h so this is the common path.
 *   2. On miss/stale, trigger `warmModelSchema()` on demand. Write the result
 *      to disk and return it.
 *   3. If that still produces nothing, fall back to any previously cached
 *      entry (even if older than the TTL) before returning 404.
 *
 * GET /api/models/:modelId?provider=replicate|fal|wavespeed|kie|gemini|muapi
 *
 * Headers (optional overrides; warmer uses env vars directly):
 *   - X-Replicate-Key, X-Fal-Key, X-WaveSpeed-Key, X-Muapi-API-Key, X-Kie-Key
 */

import { NextRequest, NextResponse } from "next/server";
import type { ProviderType } from "@/types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";
import { asLlmProvider, llmModelParameters } from "../llmSchema";
import {
  readCachedSchema,
  writeCachedSchema,
  cachedToExtracted,
} from "@/lib/schema/diskCache";
import { warmModelSchema } from "@/lib/schema/warmer";

export const runtime = "nodejs";

const CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const VALID_PROVIDERS: ProviderType[] = ["replicate", "fal", "kie", "wavespeed", "gemini", "muapi"];

interface SchemaSuccessResponse {
  success: true;
  parameters: ModelParameter[];
  inputs: ModelInput[];
  cached: boolean;
  warnings?: string[];
}

interface SchemaErrorResponse {
  success: false;
  error: string;
}

type SchemaResponse = SchemaSuccessResponse | SchemaErrorResponse;

function collectApiKeys(request: NextRequest): Partial<Record<ProviderType, string>> {
  return {
    replicate: request.headers.get("X-Replicate-Key") || process.env.REPLICATE_API_KEY || undefined,
    fal: request.headers.get("X-Fal-Key") || process.env.FAL_API_KEY || undefined,
    wavespeed: request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY || undefined,
    kie: request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY || undefined,
    muapi: request.headers.get("X-Muapi-API-Key") || process.env.MUAPI_API_KEY || undefined,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse<SchemaResponse>> {
  const { modelId } = await params;
  const decodedModelId = decodeURIComponent(modelId);
  const provider = request.nextUrl.searchParams.get("provider") as ProviderType | null;

  // ?kind=llm selects the CHAT schema. It cannot be inferred from the provider
  // alone: "gemini" already means this app's Google IMAGE provider, so
  // overloading it would make one id mean two different schemas.
  if (request.nextUrl.searchParams.get("kind") === "llm") {
    const llmProvider = asLlmProvider(provider ?? "");
    if (!llmProvider) {
      return NextResponse.json<SchemaErrorResponse>(
        { success: false, error: "Invalid LLM provider. Use google, openai or anthropic." },
        { status: 400 },
      );
    }
    const { parameters, resolved } = await llmModelParameters(llmProvider, decodedModelId, request);
    return NextResponse.json<SchemaSuccessResponse>({
      success: true,
      parameters,
      inputs: [],
      cached: false,
      // Surfaced so the UI can say the numbers are family defaults rather than
      // this model's own, instead of quietly presenting a guess as fact.
      ...(resolved ? {} : { warnings: [`No published parameter list for ${decodedModelId}; showing defaults for its model family.`] }),
    });
  }

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: `Invalid or missing provider. Use ?provider=${VALID_PROVIDERS.join(", ?provider=")}`,
      },
      { status: 400 }
    );
  }

  // Explicit API-key check for providers that can't work without one.
  const apiKeys = collectApiKeys(request);
  if (provider === "replicate" && !apiKeys.replicate) {
    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: "Replicate API key required. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
      },
      { status: 401 }
    );
  }

  // 1. Check disk cache.
  const cached = await readCachedSchema(provider, decodedModelId);
  const fresh = cached && Date.now() - cached.extractedAt < CACHE_TTL_MS;
  if (cached && fresh) {
    return NextResponse.json<SchemaSuccessResponse>({
      success: true,
      parameters: cached.parameters as ModelParameter[],
      inputs: cached.inputs as ModelInput[],
      cached: true,
      warnings: cached.warnings,
    });
  }

  // 2. Miss or stale — warm on demand.
  try {
    const result = await warmModelSchema(provider, decodedModelId, apiKeys);
    if (result) {
      try {
        await writeCachedSchema(provider, decodedModelId, result);
      } catch (err) {
        console.warn(`[ModelSchema] disk write failed for ${provider}:${decodedModelId}:`, err);
      }
      return NextResponse.json<SchemaSuccessResponse>({
        success: true,
        parameters: result.parameters,
        inputs: result.inputs,
        cached: false,
        warnings: result.health.warnings,
      });
    }

    // 3. Warm returned null — fall back to stale cache if any.
    if (cached) {
      const stale = cachedToExtracted(cached);
      return NextResponse.json<SchemaSuccessResponse>({
        success: true,
        parameters: stale.parameters,
        inputs: stale.inputs,
        cached: true,
        warnings: [
          ...(stale.health.warnings ?? []),
          "served stale — live extraction returned no schema",
        ],
      });
    }

    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: `No schema available for ${provider}:${decodedModelId}`,
      },
      { status: 404 }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ModelSchema] Error fetching ${decodedModelId}: ${errorMessage}`);

    // Fall back to cached version if we have one, even on error.
    if (cached) {
      const stale = cachedToExtracted(cached);
      return NextResponse.json<SchemaSuccessResponse>({
        success: true,
        parameters: stale.parameters,
        inputs: stale.inputs,
        cached: true,
        warnings: [
          ...(stale.health.warnings ?? []),
          `served stale — live extraction error: ${errorMessage}`,
        ],
      });
    }

    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
