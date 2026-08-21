import type { OpenRouterEntry } from "./openrouterCatalogue";

/** The node's LLMProvider values mapped onto OpenRouter's namespaces. */
const NAMESPACE: Record<string, string> = {
  google: "google",
  openai: "openai",
  anthropic: "anthropic",
};

/**
 * Resolve a native model id to its catalogue entry.
 *
 * Ordered, first match wins. Vendors ship dated and preview ids that OpenRouter
 * lists under a stable name, and a brand-new point release may not be listed at
 * all — the family prefix keeps those working with their family's parameters
 * rather than dropping straight to the declared fallback.
 */
export function resolveOpenRouterEntry(
  provider: "google" | "openai" | "anthropic",
  modelId: string,
  catalogue: Map<string, OpenRouterEntry>,
): OpenRouterEntry | null {
  const ns = NAMESPACE[provider];
  if (!ns || catalogue.size === 0 || !modelId) return null;

  const candidates = [
    modelId,
    modelId.replace(/-\d{8}$/, ""),            // claude-sonnet-4-20250514
    modelId.replace(/-(preview|latest)$/, ""), // gemini-2.5-flash-preview
  ];
  for (const c of candidates) {
    const hit = catalogue.get(`${ns}/${c}`);
    if (hit) return hit;
  }

  // Longest prefix WITHIN this provider's namespace. Never across providers —
  // a cross-provider match would hand Claude's parameter set to a GPT model.
  let best: OpenRouterEntry | null = null;
  let bestLen = 0;
  for (const [id, entry] of catalogue) {
    if (!id.startsWith(`${ns}/`)) continue;
    const bare = id.slice(ns.length + 1);
    if (!modelId.startsWith(bare)) continue;
    if (bare.length > bestLen) { best = entry; bestLen = bare.length; }
  }
  return best;
}
