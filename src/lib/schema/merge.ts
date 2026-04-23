/**
 * Merge playground-scraped field names into an ExtractedResult.
 *
 * The playground scrape returns a bag of field names we saw in the UI. For
 * any name that's NOT already in the extracted schema (as a parameter or an
 * input), we add it as a best-effort **parameter** with `type: "string"` and
 * a warning so the UI can surface it. We don't try to add it as an input
 * because we'd have to guess the handle type (image/video/audio/text).
 *
 * Fields already present in the extracted schema are left alone — we trust
 * the richer OpenAPI metadata (enums, defaults, descriptions) over the
 * name-only playground scrape.
 */

import type { ExtractedResult } from "./types";
import type { PlaygroundScrapeResult } from "./playground/types";
import type { ModelParameter } from "@/lib/providers/types";
import { EXCLUDED_PARAMS } from "./constants";

/**
 * Names we NEVER want added to a model schema even if a playground scraper
 * surfaces them — they're HTML <meta>/OpenGraph/Twitter Card / framework
 * artifacts, not form fields.
 */
const HTML_METADATA_NAMES = new Set<string>([
  "description",
  "keywords",
  "author",
  "viewport",
  "robots",
  "generator",
  "referrer",
  "theme_color",
  "color_scheme",
  "apple_mobile_web_app_title",
  "apple_mobile_web_app_capable",
  "apple_mobile_web_app_status_bar_style",
  "format_detection",
  "msapplication_tilecolor",
  "msapplication_config",
  "og_title", "og_description", "og_image", "og_url", "og_type", "og_site_name",
  "twitter_title", "twitter_description", "twitter_image", "twitter_card", "twitter_site", "twitter_creator",
  "fb_app_id",
  "copy_code", "copy", "code",
  "csrf_token", "csrf", "_token",
  "charset", "title", "lang", "dir", "id", "class",
  "submit", "button", "cancel", "close", "save", "edit", "delete",
]);

/**
 * Convert CamelCase / kebab-case / space-separated into snake_case for
 * matching against OpenAPI property names (which are usually snake_case).
 */
function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * All extracted names, with snake_case variants, indexed in a Set for fast lookup.
 */
function buildKnownNameSet(extracted: ExtractedResult): Set<string> {
  const names = new Set<string>();
  for (const p of extracted.parameters) {
    names.add(p.name);
    names.add(toSnakeCase(p.name));
  }
  for (const i of extracted.inputs) {
    names.add(i.name);
    names.add(toSnakeCase(i.name));
  }
  return names;
}

/**
 * Merge a playground scrape result into an extracted schema. Returns a new
 * ExtractedResult with:
 *   - added parameters for any playground-only field
 *   - appended warnings for each such addition
 *   - health.status transitioned to "playground-augmented" if we added anything
 */
export function mergePlaygroundFields(
  extracted: ExtractedResult,
  playground: PlaygroundScrapeResult
): ExtractedResult {
  if (playground.status !== "ok" || playground.fields.length === 0) {
    // Nothing meaningful to merge. Just attach source info as a debug warning.
    return {
      ...extracted,
      health: {
        ...extracted.health,
        warnings:
          playground.status === "error"
            ? [...extracted.health.warnings, `playground scrape failed: ${playground.error}`]
            : extracted.health.warnings,
      },
    };
  }

  const known = buildKnownNameSet(extracted);
  const newParameters: ModelParameter[] = [...extracted.parameters];
  const newWarnings: string[] = [...extracted.health.warnings];
  let added = 0;

  for (const rawField of playground.fields) {
    if (!rawField) continue;
    const field = rawField.trim();
    if (!field) continue;
    if (EXCLUDED_PARAMS.has(field)) continue;

    // Skip React/HTML-y noise that can sneak through the regex fallback.
    if (/^(true|false|null|undefined|prompt)$/i.test(field)) continue;
    if (!/^[a-z][a-z0-9_]*$/i.test(field)) continue;

    const snake = toSnakeCase(field);
    if (known.has(field) || known.has(snake)) continue;
    // Defense-in-depth: reject HTML-metadata field names outright.
    if (HTML_METADATA_NAMES.has(snake) || HTML_METADATA_NAMES.has(field)) continue;

    newParameters.push({
      name: snake,
      type: "string",
      description: `(Discovered via playground scrape — treated as optional string.)`,
      required: false,
    });
    newWarnings.push(`playground-only field added: ${snake}`);
    known.add(snake);
    added++;
  }

  if (added === 0) {
    return extracted;
  }

  return {
    parameters: newParameters,
    inputs: extracted.inputs,
    health: {
      status: "playground-augmented",
      warnings: newWarnings,
      extractedAt: extracted.health.extractedAt,
      sourceVersion: extracted.health.sourceVersion,
    },
  };
}
