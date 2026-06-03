"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { buildLlmHeaders } from "@/store/utils/buildApiHeaders";
import type { LLMProvider } from "@/types";

/**
 * Shared hook for fetching the live per-provider LLM model lists.
 *
 * The list comes from `/api/llm/models`, which fans out to each provider's
 * public models endpoint (Google `generativelanguage.googleapis.com`,
 * OpenAI `/v1/models`, Anthropic `/v1/models`) and filters to chat
 * completion models. Headers carry the user-configured API keys (via
 * `buildLlmHeaders`); when missing, the route falls back to the
 * server-side env vars.
 *
 * A module-level cache (`modelCachePromise`) deduplicates the fetch
 * across every node and panel mounted in the app — there's no point in
 * each instance hammering the providers. The cache key is the joined
 * triple of UI-side API keys plus an explicit `refreshTick`, so
 * adding / changing a key automatically re-fetches and `refresh()`
 * forces a re-fetch from any caller.
 *
 * Each provider falls back to `FALLBACK_MODELS` if its live list is
 * empty (missing key, rate-limit, network error) so the dropdown stays
 * functional offline.
 */

export interface LlmModelOption {
  value: string;
  label: string;
}

export type LlmModelLists = Record<LLMProvider, LlmModelOption[]>;

/** Minimal offline-safe list shown until the live fetch resolves, or when
 *  a provider has no key configured. Curated for the dropdown's first
 *  impression — when the live list arrives it fully replaces this. */
export const FALLBACK_MODELS: LlmModelLists = {
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-3-pro-preview", label: "Gemini 3.0 Pro" },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  ],
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
  anthropic: [
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
  ],
};

let modelCachePromise: Promise<LlmModelLists> | null = null;
let modelCacheKey: string | null = null;

async function fetchModelLists(
  headers: Record<string, string>,
  bustParam: string | null = null,
): Promise<LlmModelLists> {
  const lists: LlmModelLists = { google: [], openai: [], anthropic: [] };
  try {
    // `cache: 'no-store'` skips the browser HTTP cache so explicit
    // refreshes always hit the route. A query-string cache-buster on
    // explicit refresh also defeats any intermediary (service workers,
    // dev-tools "preserve cache", etc.).
    const url = bustParam ? `/api/llm/models?_=${bustParam}` : "/api/llm/models";
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: {
      google: { id: string; label: string }[];
      openai: { id: string; label: string }[];
      anthropic: { id: string; label: string }[];
    } = await res.json();
    for (const provider of ["google", "openai", "anthropic"] as const) {
      lists[provider] = (data[provider] || []).map((m) => ({ value: m.id, label: m.label }));
    }
  } catch (err) {
    console.warn("[useLlmModelLists] failed to fetch model list, falling back:", err);
  }
  for (const provider of ["google", "openai", "anthropic"] as const) {
    if (!lists[provider].length) lists[provider] = FALLBACK_MODELS[provider];
  }
  return lists;
}

export interface UseLlmModelLists {
  /** Live per-provider model lists. Falls back to `FALLBACK_MODELS` per
   *  provider while the fetch is pending or if it errors. */
  modelLists: LlmModelLists;
  /** Force a re-fetch (invalidates the module cache). */
  refresh: () => void;
}

export function useLlmModelLists(): UseLlmModelLists {
  const providerSettings = useWorkflowStore((s) => s.providerSettings);

  const llmKeys = useMemo(
    () => ({
      google: providerSettings.providers.gemini?.apiKey || "",
      openai: providerSettings.providers.openai?.apiKey || "",
      anthropic: providerSettings.providers.anthropic?.apiKey || "",
    }),
    [providerSettings],
  );

  const [modelLists, setModelLists] = useState<LlmModelLists>(FALLBACK_MODELS);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const cacheKey = `${llmKeys.google}|${llmKeys.openai}|${llmKeys.anthropic}|${refreshTick}`;
    if (modelCacheKey !== cacheKey || !modelCachePromise) {
      modelCacheKey = cacheKey;
      // Union all three provider headers in one request so the endpoint
      // can fan out in parallel.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      Object.assign(headers, buildLlmHeaders("google", providerSettings));
      Object.assign(headers, buildLlmHeaders("openai", providerSettings));
      Object.assign(headers, buildLlmHeaders("anthropic", providerSettings));
      // Cache-bust on every explicit refresh tick > 0 so intermediaries
      // can't serve a stale response (e.g. devtools "Preserve cache").
      const bust = refreshTick > 0 ? `${refreshTick}-${performance.now()}` : null;
      modelCachePromise = fetchModelLists(headers, bust);
    }
    let cancelled = false;
    modelCachePromise.then((lists) => {
      if (!cancelled) setModelLists(lists);
    });
    return () => { cancelled = true; };
  }, [llmKeys.google, llmKeys.openai, llmKeys.anthropic, providerSettings, refreshTick]);

  const refresh = useCallback(() => {
    modelCachePromise = null;
    modelCacheKey = null;
    setRefreshTick((n) => n + 1);
  }, []);

  return { modelLists, refresh };
}
