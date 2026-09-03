/**
 * Provider Types
 *
 * Types for multi-provider support including image generation
 * providers and LLM providers.
 */

// Provider Types for multi-provider support (image/video generation)
export type ProviderType = "gemini" | "openai" | "anthropic" | "replicate" | "fal" | "kie" | "wavespeed" | "worldlabs" | "muapi";

// Model pricing info (stored when model is selected)
export interface SelectedModelPricing {
  type: 'per-run' | 'per-second';
  amount: number;
}

// Selected model for image/video generation nodes
export interface SelectedModel {
  provider: ProviderType;
  modelId: string;
  displayName: string;
  pricing?: SelectedModelPricing;  // Optional pricing info from provider API
  capabilities?: string[];  // Model capabilities (e.g., "text-to-image", "image-to-3d")
}

export interface ProviderConfig {
  id: ProviderType;
  name: string;
  enabled: boolean;
  apiKey: string | null;
  apiKeyEnvVar?: string; // For providers using environment variables (e.g., Gemini)
}

export interface ProviderSettings {
  providers: Record<ProviderType, ProviderConfig>;
}

// LLM Provider Options
export type LLMProvider = "google" | "openai" | "anthropic";

// LLM Model Options — provider-specific model ID as returned by each
// provider's /models endpoint (e.g. "gemini-2.5-flash", "gpt-4.1-mini",
// "claude-sonnet-4-5-20250929"). The list is fetched dynamically by
// `/api/llm/models`; this stays a plain `string` so new launches don't
// need a type change to be selectable.
export type LLMModelType = string;

// Recently used models tracking
export interface RecentModel {
  provider: ProviderType;
  modelId: string;
  displayName: string;
  timestamp: number;
}

/**
 * A model the user has pinned. Unlike RecentModel this has no timestamp: it is
 * ordered by when it was starred and only the user removes it.
 *
 * Identified by provider AND modelId. RecentModel keys on modelId alone, which
 * would collide if two providers ever ship the same id; favourites are
 * long-lived, so they use the same composite key the model list renders with.
 */
export interface FavoriteModel {
  provider: ProviderType;
  modelId: string;
  displayName: string;
}

/** Stable identity for a favourite — provider-qualified, so ids cannot collide. */
export function favoriteKey(provider: ProviderType, modelId: string): string {
  return `${provider}:${modelId}`;
}
