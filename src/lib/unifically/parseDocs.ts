/**
 * Read Unifically's own documentation as a per-model input schema.
 *
 * Unifically's `GET /v1/models` lists every model a key can use — that is the
 * live catalogue — but carries no input schema. The parameters live on the
 * docs site, which publishes the whole thing as one plain-text file
 * (https://docs.unifically.com/llms-full.txt). Every generation model page in
 * it has the same shape:
 *
 *     # Veo 3.1
 *     Source: https://docs.unifically.com/models/video/google/veo-3.1
 *     ...
 *     | Parameter | Type | Required | Default | Description |
 *     | `prompt`  | string | Yes | - | Main video prompt. ... |
 *     | `aspect_ratio` | string | No | `"16:9"` | ... Allowed: `"16:9"`, `"9:16"`. |
 *     ...
 *     "model": "google/veo-3.1-fast",
 *
 * So the schema for a model id is the Parameters table of the page that
 * mentions it. Measured against the live catalogue: 128 of 138 enabled
 * generation models are found this way. The rest get no schema here and fall
 * back to a generic one — the live list, not the docs, decides what exists.
 *
 * Pages are mapped to ids two ways, because neither alone is enough: the curl
 * examples (`"model": "x"`) cover most pages, and family pages such as Veo 3.1
 * name extra variants only in a "Model ID" table.
 */

import type { NormalizedProperty, NormalizedSchema } from "@/lib/schema/types";

export interface DocPage {
  url: string;
  body: string;
}

const PAGE_START = /\n(?=# [^\n]+\nSource: https:\/\/docs\.unifically\.com\/)/;
const PAGE_HEAD = /^# [^\n]+\nSource: (https:\/\/docs\.unifically\.com\/\S+)/;

/** Generation model pages (video / image / audio). LLM pages are excluded. */
export function splitModelPages(llmsFull: string): DocPage[] {
  const pages: DocPage[] = [];
  for (const part of llmsFull.split(PAGE_START)) {
    const m = PAGE_HEAD.exec(part);
    if (!m) continue;
    const url = m[1];
    if (!/\/models\/(video|image|audio)\//.test(url)) continue;
    pages.push({ url, body: part });
  }
  return pages;
}

/** Markdown table cells, honouring escaped pipes (`\|`). */
function cells(line: string): string[] {
  const PIPE = "\u0000";
  return line
    .trim()
    .replace(/\\\|/g, PIPE)
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.replace(new RegExp(PIPE, "g"), "|").trim());
}

interface Table {
  header: string[];
  rows: string[][];
  /** Text of the innermost heading above the table. */
  heading: string;
  /** Text of that heading's section: heading line up to the next heading of the same or higher level. */
  section: string;
}

const HEADING = /^(#{2,6})\s+(.*)$/;

function tables(body: string): Table[] {
  const lines = body.split("\n");
  const out: Table[] = [];
  let headingIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (HEADING.test(lines[i])) headingIdx = i;
    if (!lines[i].startsWith("|") || !/^\|\s*:?-/.test(lines[i + 1])) continue;
    const header = cells(lines[i]).map((h) => h.toLowerCase());
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].startsWith("|"); j++) rows.push(cells(lines[j]));

    let heading = "";
    let section = "";
    if (headingIdx >= 0) {
      const level = HEADING.exec(lines[headingIdx])![1].length;
      heading = HEADING.exec(lines[headingIdx])![2].trim();
      let end = headingIdx + 1;
      for (; end < lines.length; end++) {
        const h = HEADING.exec(lines[end]);
        if (h && h[1].length <= level) break;
      }
      section = lines.slice(headingIdx, end).join("\n");
    }
    out.push({ header, rows, heading, section });
    i = j - 1;
  }
  return out;
}

const ID_IN_TEXT = /`([a-z0-9-]+\/[a-z0-9.\-]+)`|"model"\s*:\s*"([a-z0-9-]+\/[a-z0-9.\-]+)"/g;

/**
 * Model ids a stretch of text DECLARES, in backticks or as a request's "model".
 *
 * Mentions inside markdown links and inside table rows are cross-references,
 * not declarations, and are ignored. Gemini Omni Flash's parameter table says
 * "can also be upscaled later with [`google/veo-3.1-upscale`](...)"; counting
 * that made Omni Flash's own table look scoped to the Veo upscaler, so the
 * upscaler inherited Omni Flash's parameters and Omni Flash lost them.
 */
function idsIn(text: string): string[] {
  const prose = text
    .split("\n")
    .filter((line) => !line.startsWith("|"))
    .join("\n")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "");
  const ids = new Set<string>();
  for (const m of prose.matchAll(ID_IN_TEXT)) ids.add(m[1] ?? m[2]);
  return [...ids];
}

const unquote = (s: string) => s.replace(/`/g, "").replace(/^"(.*)"$/, "$1").trim();

/** Model ids a page documents: its curl examples plus any "Model ID" table. */
export function modelIdsOnPage(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/"model"\s*:\s*"([a-z0-9-]+\/[a-z0-9.\-]+)"/g)) ids.add(m[1]);
  for (const t of tables(body)) {
    const col = t.header.findIndex((h) => h.includes("model id"));
    if (col < 0) continue;
    for (const r of t.rows) {
      const id = /`([a-z0-9-]+\/[a-z0-9.\-]+)`/.exec(r[col] ?? "")?.[1];
      if (id) ids.add(id);
    }
  }
  // Ids named only in a scoped section's prose (Veo's Extend / Upscale).
  for (const t of tables(body)) {
    if (t.header[0] === "parameter") for (const id of idsIn(t.section)) ids.add(id);
  }
  return [...ids];
}

/**
 * Map a doc "Type" cell onto a normalized type.
 *
 * A bare `array` is ambiguous in these docs: `reference_image_urls` is a list
 * of URLs, `reference_characters` is a list of objects that each carry their
 * own `image_urls`. Treating the second as a URL list would make it an image
 * pin and send bare URLs where objects belong, so a bare array is only a list
 * of strings when its NAME says it holds URLs or ids.
 */
const STRINGY_ARRAY_NAME = /(urls?|ids|list|images|videos|audios|tags|codes)$/i;

function toType(raw: string, name: string): Pick<NormalizedProperty, "type" | "items" | "unionVariants"> {
  const t = raw.replace(/[\\`]/g, "").toLowerCase().trim();
  const stringItems: NormalizedProperty = { name: "item", type: "string" };
  const objectItems: NormalizedProperty = { name: "item", type: "object" };
  // "string or array", "string/array" — a value that may be one or several.
  if (/\bor\b|\//.test(t) && /array|\[\]/.test(t)) {
    return {
      type: "union",
      unionVariants: [
        { name: "value", type: "string" },
        { name: "value", type: "array", items: stringItems },
      ],
    };
  }
  if (t.endsWith("[]") || t.includes("array")) {
    const isString = t.startsWith("string");
    const bare = t === "array";
    return {
      type: "array",
      items: isString || (bare && STRINGY_ARRAY_NAME.test(name)) ? stringItems : objectItems,
    };
  }
  if (/^(integer|int)\b/.test(t)) return { type: "integer" };
  if (/^(number|float|double)\b/.test(t)) return { type: "number" };
  if (/^bool/.test(t)) return { type: "boolean" };
  if (/^object/.test(t)) return { type: "object" };
  return { type: "string" };
}

interface DescribedValues {
  enum?: string[];
  examples?: string[];
  default?: string;
}

const TICKED = /`"?([^`"]+)"?`/g;
/** One listed value, optionally annotated: `pro`, `pro` (1080p), `5` (default). */
const LIST_ITEM = /`[^`]+`(?:\s*\([^)]*\))?/.source;
/** Two or more listed values and nothing else, bar a trailing unit. */
const PURE_LIST = new RegExp(
  `^${LIST_ITEM}(?:\\s*(?:,\\s*or|,|or|\\|)\\s*${LIST_ITEM})+\\s*(?:seconds?|s|px)?\\s*\\.?$`,
  "i"
);
/** A sentence opener that introduces a closed list: "Allowed:", "One of", "Output container:". */
const LIST_LEAD = /^(?:(?:allowed(?: values)?|available|one of|options|valid values|supported values)\s*:?|[^`:]*(?:`[^`]*`[^`:]*)*:)\s*/i;

/**
 * Value sets in a description. The docs have no enum column and phrase a
 * closed set a dozen ways — "`720p`, `1080p`, `4k`", "`5` or `10` seconds",
 * "One of `mp4`, `webm`", "Allowed: `16:9`, `9:16`", "`std` (default) or
 * `pro`" — so a sentence counts as one when, after an optional lead-in, it is
 * nothing but two or more backticked values. Reading only "Allowed:" left most
 * of these as free-text boxes that took any typo.
 *
 * "e.g." lists are examples, never a closed set. A list naming other fields of
 * the same table ("provide exactly one of `text`, `ssml`") is not a value set.
 */
export function describedValues(description: string, fieldNames: ReadonlySet<string> = new Set()): DescribedValues {
  const out: DescribedValues = {};
  // Sentence breaks; a dot inside a value (`1.5`) is never followed by a space,
  // and "e.g." does not end a sentence.
  for (const raw of description.split(/(?<=\.)(?<!\b(?:e\.g|i\.e|etc|vs)\.)\s+/i)) {
    let s = raw.replace(/^[*\\]+/, "").trim();
    const def = /\(default:?\s*`"?([^`"]+)"?`\)|^default:?\s*`"?([^`"]+)"?`/i.exec(s);
    if (def && out.default === undefined) out.default = def[1] ?? def[2];
    s = s.replace(/\s*\(default:?\s*`[^`]+`\)/i, "").trim();
    const values = [...s.matchAll(TICKED)].map((m) => m[1]);
    if (/\b(e\.g\.|for example|such as)/i.test(s)) {
      if (values.length >= 2 && !out.examples) out.examples = values;
      continue;
    }
    const marked = /`"?([^`"]+)"?`\s*\(default\)/i.exec(s);
    if (marked && out.default === undefined) out.default = marked[1];
    if (out.enum) continue;
    // A trailing aside ("; see Pricing") does not stop a list being one.
    const body = s.replace(LIST_LEAD, "").replace(/\s*;.*$/, "");
    const isList = PURE_LIST.test(body) || /^`[^`]+`\s+only\.?$/i.test(body);
    // Values from the list alone: a lead-in can name a model ("`suno-ai/mp3` only:").
    const listed = [...body.matchAll(TICKED)].map((m) => m[1]);
    if (isList && !listed.every((v) => fieldNames.has(v))) out.enum = listed;
  }
  return out;
}

function typedValue(v: string, type: NormalizedProperty["type"]): unknown {
  if (type !== "integer" && type !== "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toDefault(raw: string | undefined, type: NormalizedProperty["type"]): unknown {
  if (!raw) return undefined;
  const v = unquote(raw);
  if (!v || v === "-" || /^(random|none|null|auto-generated|n\/a|—|–)$/i.test(v)) return undefined;
  if (type === "integer" || type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") return v === "true" ? true : v === "false" ? false : undefined;
  return v;
}

type TableKind = "common" | "scoped" | "general" | "nested";

/**
 * What a Parameters table applies to, from the section it sits in.
 *
 *  - "common": headed "Common Parameters" — every model on the page.
 *  - "scoped": its section names or demonstrates particular model ids (Veo's
 *    Extend and Upscale, each Hailuo version, each Suno edit operation).
 *  - "general": headed "Parameters" with no ids in its section — every model
 *    on the page that no scoped section claims.
 *  - "nested": anything else ("Elements", "Dialogue Object") — the inside of a
 *    single field, which must not become top-level parameters.
 */
function classifyTable(t: Table): { kind: TableKind; ids: string[] } {
  if (/\b(object|element|item)s?\b/i.test(t.heading)) return { kind: "nested", ids: [] };
  if (/common/i.test(t.heading)) return { kind: "common", ids: [] };
  const ids = idsIn(t.section);
  if (ids.length) return { kind: "scoped", ids };
  if (/parameters?/i.test(t.heading) || !t.heading) return { kind: "general", ids: [] };
  return { kind: "nested", ids: [] };
}

function tableProperties(t: Table, into: Record<string, NormalizedProperty>, required: string[]): void {
  const col = (name: string) => t.header.indexOf(name);
  const iType = col("type");
  const iReq = col("required");
  const iDef = col("default");
  const iDesc = col("description");
  const fieldNames = new Set(t.rows.map((r) => unquote(r[0] ?? "")));
  for (const r of t.rows) {
    const name = unquote(r[0] ?? "");
    if (!/^[a-z_][a-z0-9_]*$/i.test(name) || into[name]) continue;
    const shape = toType(iType >= 0 ? r[iType] ?? "" : "", name);
    const description = iDesc >= 0 ? r[iDesc] : undefined;
    const prop: NormalizedProperty = { name, ...shape, source: "static" };
    if (description) prop.description = description;
    const scalar = shape.type === "string" || shape.type === "integer" || shape.type === "number";
    const described = description && scalar ? describedValues(description, fieldNames) : {};
    const asType = (vs: string[] | undefined) => {
      const typed = vs?.map((v) => typedValue(v, shape.type));
      // A number field listing a non-number is prose, not a value set.
      return typed && typed.every((v) => v !== undefined) ? typed : undefined;
    };
    const enumVals = asType(described.enum);
    if (enumVals) prop.enum = enumVals;
    const examples = asType(described.examples);
    if (examples && !enumVals) prop.examples = examples;
    const def =
      toDefault(iDef >= 0 ? r[iDef] : undefined, shape.type) ??
      (described.default !== undefined ? typedValue(described.default, shape.type) : undefined);
    if (def !== undefined) prop.default = def;
    if (iReq >= 0 && /^yes\b/i.test(r[iReq] ?? "")) {
      prop.required = true;
      required.push(name);
    }
    into[name] = prop;
  }
}

/** Every model id on one page → its schema. First definition of a field wins. */
export function parsePageSchemas(body: string): Map<string, NormalizedSchema> {
  const pageIds = modelIdsOnPage(body);
  const paramTables = tables(body)
    .filter((t) => t.header[0] === "parameter")
    .map((t) => ({ t, ...classifyTable(t) }));

  const claimed = new Set(paramTables.filter((x) => x.kind === "scoped").flatMap((x) => x.ids));

  const out = new Map<string, NormalizedSchema>();
  for (const id of pageIds) {
    const properties: Record<string, NormalizedProperty> = {};
    const required: string[] = [];
    for (const x of paramTables) {
      const applies =
        x.kind === "common" ||
        (x.kind === "scoped" && x.ids.includes(id)) ||
        (x.kind === "general" && !claimed.has(id));
      if (applies) tableProperties(x.t, properties, required);
    }
    // Safety net: an id that no table applies to (its page scopes every table
    // to siblings) takes all of the page's non-nested tables rather than none.
    if (!Object.keys(properties).length) {
      for (const x of paramTables) if (x.kind !== "nested") tableProperties(x.t, properties, required);
    }
    if (Object.keys(properties).length) out.set(id, { properties, required, source: "static" });
  }
  return out;
}

/** Model id → schema, for every model the docs describe. */
export function buildSchemaIndex(llmsFull: string): Map<string, NormalizedSchema> {
  const index = new Map<string, NormalizedSchema>();
  for (const page of splitModelPages(llmsFull)) {
    for (const [id, schema] of parsePageSchemas(page.body)) if (!index.has(id)) index.set(id, schema);
  }
  return index;
}
