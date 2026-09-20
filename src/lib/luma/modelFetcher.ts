/**
 * Build the Luma model list at runtime from Luma's own documentation.
 *
 * Luma has no models endpoint (control-tested: `GET /v1/models` returns the
 * same "Backend service does not exist" as a made-up path), so the catalogue is
 * derived from the docs instead — see parseDocs.ts for why the API-reference
 * page is machine-readable.
 *
 * node-banana addresses a Luma model as `"<model>/<type>"`, because one Luma
 * model covers several generation types and each is a different node-level
 * capability. So the catalogue is the cross product of the models Luma
 * documents and the types each supports.
 *
 * Shape of the fallback: a snapshot is used ONLY when the fetch or the parse
 * fails. It is never consulted to decide whether a fetched model is allowed —
 * that would turn it back into the hardcoded list this exists to avoid.
 *
 * Likewise, a model whose supported types cannot be determined is offered with
 * EVERY type rather than none. An unknown new model should be reachable and let
 * the API refuse it, not be silently hidden by a stale matrix.
 */

import type { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { parseParamTree, parseModels, parseTypes } from "./parseDocs";

const DOCS_BASE = "https://docs.agents.lumalabs.ai";
const API_REF = `${DOCS_BASE}/api/resources/generations/methods/create/index.md`;
const MODEL_GUIDE = `${DOCS_BASE}/guides/model/index.md`;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

/** Capability reported to the rest of the app, per generation type. */
const TYPE_CAPABILITY: Record<string, ModelCapability> = {
  image: "text-to-image",
  image_edit: "image-to-image",
  layering: "image-to-image",
  video: "text-to-video",
  video_edit: "video-to-video",
  video_reframe: "video-to-video",
};

/** Human labels for the types, so the browser reads as prose. */
const TYPE_LABEL: Record<string, string> = {
  image: "Image",
  image_edit: "Image Edit",
  layering: "Layering",
  video: "Video",
  video_edit: "Video Edit",
  video_reframe: "Video Reframe",
};

/**
 * Last-resort catalogue, captured from the docs on 2026-09-18.
 *
 * Only reached when the docs cannot be fetched or parsed. Deliberately small:
 * its job is to keep the app usable during an outage, not to be authoritative.
 */
const FALLBACK: Array<{ model: string; types: string[] }> = [
  { model: "uni-1", types: ["image", "image_edit", "layering"] },
  { model: "uni-1-max", types: ["image", "image_edit"] },
  { model: "ray-3.2", types: ["video", "video_edit", "video_reframe"] },
];

let cached: ProviderModel[] | null = null;
let cachedAt = 0;
let inFlight: Promise<ProviderModel[]> | null = null;

/**
 * Fetch one docs page as markdown.
 *
 * Returns null unless the response is BOTH ok and `text/plain`. This host
 * answers a bad path with a 64KB HTML page — which would parse as "no models
 * found" and be indistinguishable from a real empty answer, so it is rejected
 * on content type rather than trusted.
 */
async function fetchDoc(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const ctype = resp.headers.get("content-type") ?? "";
    if (!ctype.includes("text/plain")) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Parse the models guide's "At a glance" table into model → supported types.
 *
 * Column positions are read from the header row rather than assumed, so the
 * table can gain columns or be reordered without breaking.
 *
 * This table is display copy and is NOT complete — the word "layering" does not
 * appear on that page at all, though uni-1 supports it. So its answer is merged
 * with, not substituted for, the types found elsewhere.
 */
export function parseModelTypeMatrix(md: string): Record<string, string[]> | null {
  const lines = md.split(/\r?\n/);
  let modelCol = -1;
  let supportsCol = -1;
  const out: Record<string, string[]> = {};

  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;

    if (modelCol < 0) {
      const m = cells.findIndex((c) => /^model$/i.test(c));
      const s = cells.findIndex((c) => /^supports$/i.test(c));
      if (m >= 0 && s >= 0) {
        modelCol = m;
        supportsCol = s;
      }
      continue;
    }
    if (/^-+:?$|^:?-+/.test(cells[0])) continue; // the rule row

    const model = cells[modelCol]?.match(/`([^`]+)`/)?.[1];
    if (!model) continue;
    const types = [...(cells[supportsCol] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (types.length) out[model] = types;
  }

  return modelCol >= 0 && Object.keys(out).length ? out : null;
}

/**
 * Which models a type's options field names, if it names any.
 *
 * Luma documents per-type model constraints in prose on the options object for
 * that type — `layering` says "(model uni-1)". Returns null when the field does
 * not exist or names no model, so "unconstrained" stays distinct from "none".
 */
function modelsNamedByTypeOptions(
  tree: ReturnType<typeof parseParamTree>,
  type: string
): string[] | null {
  if (!tree) return null;
  const node = tree.find((n) => n.name === type);
  const desc = node?.description;
  if (!desc) return null;
  const named = [...desc.matchAll(/\bmodel\s+([A-Za-z0-9][A-Za-z0-9.\-]*)/g)].map((m) => m[1]);
  return named.length ? named : null;
}

function toProviderModel(model: string, type: string): ProviderModel {
  const capability = TYPE_CAPABILITY[type];
  return {
    id: `${model}/${type}`,
    name: `${model} — ${TYPE_LABEL[type] ?? type}`,
    description: `Luma Agents ${model}, ${type.replace(/_/g, " ")}.`,
    provider: "luma",
    capabilities: capability ? [capability] : [],
    pageUrl: `${DOCS_BASE}/guides/model/`,
  };
}

/** Build the catalogue from already-fetched markdown. Exported for testing. */
export function buildLumaModels(apiRefMd: string | null, modelGuideMd: string | null): ProviderModel[] | null {
  if (!apiRefMd) return null;
  const tree = parseParamTree(apiRefMd);
  if (!tree) return null;

  const models = parseModels(tree);
  const allTypes = parseTypes(tree);
  if (!models?.length || !allTypes?.length) return null;

  const matrix = modelGuideMd ? parseModelTypeMatrix(modelGuideMd) : null;

  const out: ProviderModel[] = [];
  for (const model of models) {
    // A model the matrix does not mention gets every type: better to offer a
    // combination the API may refuse than to hide a model that exists.
    const declared = matrix?.[model];
    let types = declared?.length ? declared.filter((t) => allTypes.includes(t)) : [...allTypes];

    // The matrix omits some types entirely — "layering" does not appear on that
    // page at all. Recover them from the API reference, which states the
    // constraint in the type's own options field ("Layer-extraction options for
    // type=layering (model uni-1)"). Parsing that is why uni-1 gains layering
    // and uni-1-max does not; a blanket "image models get layering" rule
    // invented uni-1-max/layering, a pair the API rejects.
    for (const extra of allTypes) {
      if (types.includes(extra)) continue;
      const restricted = modelsNamedByTypeOptions(tree, extra);
      if (restricted?.includes(model)) types = [...types, extra];
    }

    for (const type of types) out.push(toProviderModel(model, type));
  }
  return out.length ? out : null;
}

/**
 * The Luma catalogue, cached in memory for a day.
 *
 * Concurrent callers share one fetch. On any failure the previous good result
 * is preferred over the snapshot, and the snapshot over nothing.
 */
export async function getLumaModels(): Promise<ProviderModel[]> {
  if (cached && Date.now() - cachedAt < CACHE_TTL) return cached;

  if (!inFlight) {
    inFlight = (async () => {
      try {
        const [apiRef, guide] = await Promise.all([fetchDoc(API_REF), fetchDoc(MODEL_GUIDE)]);
        const built = buildLumaModels(apiRef, guide);
        if (built) {
          cached = built;
          cachedAt = Date.now();
          return built;
        }
        console.warn("[luma] docs unavailable or unparseable — using snapshot");
        return cached ?? FALLBACK.flatMap((f) => f.types.map((t) => toProviderModel(f.model, t)));
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

/**
 * The API-reference markdown, cached for a day.
 *
 * Shared with the schema builder so selecting a model and drawing its pins do
 * not fetch the same page twice.
 */
let cachedApiRef: string | null = null;
let cachedApiRefAt = 0;

export async function getLumaApiRef(): Promise<string | null> {
  if (cachedApiRef && Date.now() - cachedApiRefAt < CACHE_TTL) return cachedApiRef;
  const md = await fetchDoc(API_REF);
  if (md) {
    cachedApiRef = md;
    cachedApiRefAt = Date.now();
  }
  return md ?? cachedApiRef;
}

/** Drop the in-memory catalogue (tests; also lets a restart pick up doc edits). */
export function clearLumaModelCache(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
  cachedApiRef = null;
  cachedApiRefAt = 0;
}
