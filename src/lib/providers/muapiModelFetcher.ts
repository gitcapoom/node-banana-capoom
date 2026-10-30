/**
 * muapi.ai Dynamic Model Fetcher
 *
 * The model list comes from muapi's OpenAPI spec (see listModelsFromSpec).
 * If the spec is unreachable it falls back to scraping
 * https://muapi.ai/playground, then to the hardcoded MUAPI_MODELS list.
 *
 * Used server-side by /api/models route.
 *
 * Cache: refreshes every 24 hours.
 */

import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { fetchMuapiOpenApiSpec } from "@/lib/schema/normalize/muapi";

const PLAYGROUND_URL = "https://muapi.ai/playground";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/** Category label → ModelCapability mapping */
const CATEGORY_MAP: Record<string, ModelCapability> = {
  "Text to Image": "text-to-image",
  "Image to Image": "image-to-image",
  "Text to Video": "text-to-video",
  "Image to Video": "image-to-video",
  "Video to Video": "video-to-video",
  "Text to Audio": "text-to-audio",
  "Audio to Video": "image-to-video", // audio-input models render as image-to-video
  // Present in the payload and previously dropped on the floor: the anchor
  // scrape never surfaced them, so nobody noticed muapi has 3D models too.
  "Image to 3D": "image-to-3d",
  "Text to 3D": "text-to-3d",
  // Deliberately unmapped: "Text to Text" (LLM), "Training", "Lora Support",
  // "other" — none is a generation capability this app renders a node for.
};

/** In-memory cache */
let cachedModels: ProviderModel[] | null = null;
let cacheTimestamp = 0;
let fetchPromise: Promise<ProviderModel[]> | null = null;

/** Generate display name from slug */
function slugToName(slug: string): string {
  return slug
    .split("-")
    .map((w) => {
      const wl = w.toLowerCase();
      if (["i2v", "t2v", "i2i", "t2i", "v2v", "xl", "hd", "4k", "pro", "std"].includes(wl)) return w.toUpperCase();
      if (wl.match(/^v\d/)) return w.toUpperCase();
      if (wl === "ai") return "AI";
      if (wl === "gpt4o") return "GPT-4o";
      if (wl === "openai") return "OpenAI";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * Extract models from the JSON payload embedded in the playground page.
 *
 * The page renders only a slice of the catalogue as <a href="/playground/…">
 * cards and carries the whole thing as escaped JSON in the streamed payload.
 * Measured 2026-08-21: 616 model records in the JSON, 115 reachable as anchors.
 * Reading anchors therefore missed 502 models — including every recent
 * seedance-2.5 variant — and the app was serving 284 from a cache built when
 * the page happened to render more of them. The next cache refresh would have
 * SHRUNK the list to ~115 with nothing to explain why.
 *
 * Records look like (unescaped):
 *   {"id":593,"name":"seedance-2.5-intl-first-last-frame-1080p",
 *    "description":"…","category":"Image to Video","hidden":false}
 *
 * Still a scrape of an undocumented shape — muapi publishes no models API — so
 * the anchor parser is kept as a fallback for the day this format changes.
 */
function parsePayloadJson(html: string): ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();

  // Fields appear in a stable order within each record. Matching them together
  // rather than separately keeps a name bound to ITS OWN category — scanning
  // for fields independently would pair the wrong ones.
  const recordRe =
    /\\"name\\":\\"([a-z0-9][a-z0-9._-]*)\\"[\s\S]{0,4000}?\\"category\\":\\"([^\\"]+)\\"/g;

  let m: RegExpExecArray | null;
  while ((m = recordRe.exec(html)) !== null) {
    const slug = m[1];
    const capability = CATEGORY_MAP[m[2]];
    if (!capability || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      id: slug,
      name: slugToName(slug),
      provider: "muapi",
      capabilities: [capability],
      description: null,
    });
  }

  return models;
}

/**
 * Fallback: the original anchor scrape.
 *
 * Kept because the JSON payload's shape is undocumented and can change without
 * notice. If it ever yields nothing, a partial list beats an empty one.
 */
function parsePlaygroundHtml(html: string): ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();

  // Match: href="/playground/SLUG" ... followed by category span
  // The pattern: each <a> block contains href, then category in a <span>
  const categoryLabels = Object.keys(CATEGORY_MAP);
  const categoryPattern = categoryLabels.map((c) => c.replace(/\s/g, "\\s")).join("|");

  // Extract slug + category pairs using a regex that finds them within the same <a> block
  // Pattern: href="/playground/{slug}" ... then category label before the next </a>
  const linkRegex = new RegExp(
    `href="/playground/([a-z0-9][a-z0-9._-]*)"[\\s\\S]*?>(${categoryPattern})<`,
    "gi"
  );

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const slug = match[1];
    const categoryLabel = match[2];

    // Skip duplicates, invalid slugs, and non-model pages
    if (seen.has(slug) || slug.includes("/") || slug.endsWith(".js")) continue;
    seen.add(slug);

    // Map category
    const capability = CATEGORY_MAP[categoryLabel];
    if (!capability) continue;

    models.push({
      id: slug,
      name: slugToName(slug),
      provider: "muapi",
      capabilities: [capability],
      description: null,
    });
  }

  return models;
}

/**
 * OpenAPI tag → capability. The spec tags every endpoint; tags not listed
 * here (LLM, Auth, Dashboard, Storyboard, …) are not generation models this
 * app renders a node for.
 */
const SPEC_TAG_MAP: Record<string, ModelCapability> = {
  "Video: Text-to-Video": "text-to-video",
  "Video: Image-to-Video": "image-to-video",
  "Video: Edit & Effects": "video-to-video",
  "Video: Lipsync": "video-to-video",
  "Video: Avatars": "image-to-video",
  "Image: Text-to-Image": "text-to-image",
  "Image: Edit & Reference": "image-to-image",
  "Image: Enhance": "image-to-image",
  Audio: "text-to-audio",
  "3D Generation": "image-to-3d",
};

/**
 * The catalogue from muapi's OpenAPI spec — the same document the schemas
 * come from, so a listed id always has its real schema.
 *
 * The playground scrape this replaces read an undocumented page that keeps
 * changing shape (2026-10: 21 models parsed, so the app fell back to a
 * hardcoded list from March whose ids muapi had since renamed —
 * `seedance-v2.0-omni-reference` is now `seedance-2.0-omni-reference` — and
 * which lacked every Seedance 2.5 and 1080p/4K endpoint). A missing spec
 * path also sent the schema lookup to a slug guess, which read
 * "omni-reference" as an IMAGE model: 1k/2k/4k, no duration.
 */
export function listModelsFromSpec(spec: Record<string, unknown>): ProviderModel[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const models: ProviderModel[] = [];
  for (const [path, ops] of Object.entries(paths)) {
    const slug = /^\/api\/v1\/([a-z0-9][a-z0-9._-]*)$/i.exec(path)?.[1];
    const post = ops?.post;
    if (!slug || !post) continue;
    const body = (post.requestBody as { content?: Record<string, unknown> } | undefined)?.content;
    if (!body?.["application/json"]) continue; // not a generation call
    const tags = (post.tags as string[] | undefined) ?? [];
    const capability = tags.map((t) => SPEC_TAG_MAP[t]).find(Boolean);
    if (!capability) continue;
    models.push({
      id: slug,
      name: slugToName(slug),
      provider: "muapi",
      capabilities: [
        capability === "image-to-3d" && /text/i.test(slug) ? "text-to-3d" : capability,
      ],
      description: typeof post.summary === "string" ? post.summary : null,
    });
  }
  return models;
}

async function fetchModelsFromSpec(): Promise<ProviderModel[] | null> {
  const spec = await fetchMuapiOpenApiSpec();
  if (!spec) return null;
  const models = listModelsFromSpec(spec);
  if (models.length < 50) {
    console.warn(`[muapi] Only ${models.length} models in the OpenAPI spec — trying the playground`);
    return null;
  }
  console.log(`[muapi] ${models.length} models from the OpenAPI spec`);
  return models;
}

/**
 * Fetch models from muapi.ai playground.
 * Returns the model list, or null if fetch fails.
 */
async function fetchModelsFromPlayground(): Promise<ProviderModel[] | null> {
  try {
    console.log("[muapi] Fetching model list from muapi.ai/playground...");
    const response = await fetch(PLAYGROUND_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NodeBanana/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    if (!response.ok) {
      console.warn(`[muapi] Playground fetch failed: ${response.status}`);
      return null;
    }

    const html = await response.text();
    const models = parseModels(html);

    if (models.length < 50) {
      // Sanity check — if we got very few models, something went wrong
      console.warn(`[muapi] Only ${models.length} models parsed — falling back to hardcoded list`);
      return null;
    }

    console.log(`[muapi] Successfully fetched ${models.length} models from playground`);
    return models;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[muapi] Playground fetch error: ${msg} — using hardcoded list`);
    return null;
  }
}

/**
 * Get muapi.ai models — fetches dynamically with 24h cache,
 * falls back to hardcoded list on failure.
 */
export async function getMuapiModels(fallbackModels: ProviderModel[]): Promise<ProviderModel[]> {
  // Return cached if fresh
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedModels;
  }

  // Deduplicate concurrent fetches
  if (!fetchPromise) {
    fetchPromise = (async () => {
      try {
        const freshModels = (await fetchModelsFromSpec()) ?? (await fetchModelsFromPlayground());
        if (freshModels) {
          cachedModels = freshModels;
          cacheTimestamp = Date.now();
          return freshModels;
        }
        // Fetch failed — use fallback
        return cachedModels || fallbackModels;
      } finally {
        fetchPromise = null;
      }
    })();
  }

  return fetchPromise;
}


/**
 * Prefer the full JSON catalogue; fall back to the anchor scrape.
 */
export function parseModels(html: string): ProviderModel[] {
  const fromJson = parsePayloadJson(html);
  if (fromJson.length > 0) return fromJson;
  console.warn("[muapi] JSON payload yielded no models — falling back to anchor scrape.");
  return parsePlaygroundHtml(html);
}
