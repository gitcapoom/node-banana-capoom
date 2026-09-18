/**
 * Read Luma Agents' own API-reference markdown as a machine-readable contract.
 *
 * Luma publishes no models endpoint — `GET /v1/models` returns the same
 * "Backend service does not exist" as a made-up path (control-tested) — and an
 * unknown model gives `{"detail":"Unknown model: X"}` without listing the valid
 * ones. So the model list cannot come from the API.
 *
 * It can come from the docs. Every docs page is also served as clean markdown
 * at `<page-path>/index.md`, and the API-reference page is generated from the
 * spec, so its body-parameter list is strictly regular:
 *
 *     - `model: optional Model`
 *
 *       Model identifier. ...
 *
 *       - `"uni-1"`
 *       - `"uni-1-max"`
 *
 *     - `video: optional VideoOptions`
 *
 *       - `resolution: optional VideoResolution`
 *
 * Two bullet shapes, two-space indent per level: a FIELD (`name: typespec`) and
 * an ENUM MEMBER (a bare quoted string). That is the whole grammar.
 *
 * Parsing this rather than hardcoding a table is the point: when Luma ships a
 * new model or a new parameter, it appears here without a code change.
 *
 * IMPORTANT — the docs are not always current. Their `VideoResolution` lists
 * 360p/540p/720p/1080p, but the live API also accepts `1440p`. Treat enum
 * members from here as a STARTING POINT that a live probe may correct; the
 * field/structure information is reliable, the membership is not always.
 */

/** One node of the body-parameter tree. */
export interface LumaParamNode {
  /** Wire name, e.g. "aspect_ratio". */
  name: string;
  /** Raw type text as written, e.g. `optional "png" or "jpeg"` or `optional Model`. */
  typeSpec: string;
  /** True when the docs mark the field `optional`. */
  optional: boolean;
  /** First paragraph of prose under the bullet, if any. */
  description?: string;
  /** Quoted members listed directly beneath, in document order. */
  enumValues?: string[];
  /** Nested fields listed directly beneath. */
  children?: LumaParamNode[];
}

const SECTION_START = /^###\s+Body Parameters\s*$/;
const SECTION_END = /^###\s+/;

// - `name: optional Something`   (indent captured so we can build the tree)
const FIELD_RE = /^(\s*)-\s+`([A-Za-z_][A-Za-z_0-9]*)\s*:\s*(.+?)`\s*$/;
// - `"value"`
const ENUM_RE = /^(\s*)-\s+`"([^"]*)"`\s*$/;

/**
 * Parse the `### Body Parameters` section into a tree.
 *
 * Returns `null` — never `[]` — when the section is missing, so a restructured
 * docs page reads as FAILURE rather than as "this API has no parameters". That
 * distinction is the difference between falling back and silently shipping an
 * empty schema.
 */
export function parseParamTree(md: string): LumaParamNode[] | null {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_START.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  const roots: LumaParamNode[] = [];
  // Stack of (indent, node) — the node a bullet at deeper indent belongs to.
  const stack: Array<{ indent: number; node: LumaParamNode }> = [];
  let last: { indent: number; node: LumaParamNode } | null = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_END.test(line)) break;

    const enumM = ENUM_RE.exec(line);
    if (enumM) {
      const indent = enumM[1].length;
      // An enum member belongs to the nearest field ABOVE it at lower indent.
      const owner = ownerFor(stack, indent);
      if (owner) (owner.enumValues ??= []).push(enumM[2]);
      continue;
    }

    const fieldM = FIELD_RE.exec(line);
    if (fieldM) {
      const indent = fieldM[1].length;
      const typeSpec = fieldM[3].trim();
      const node: LumaParamNode = {
        name: fieldM[2],
        typeSpec,
        optional: /^optional\b/.test(typeSpec),
      };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].node : null;
      if (parent) (parent.children ??= []).push(node);
      else roots.push(node);
      stack.push({ indent, node });
      last = { indent, node };
      continue;
    }

    // Prose directly under the most recent bullet becomes its description.
    const text = line.trim();
    if (text && last && !last.node.description) last.node.description = text;
  }

  return roots.length ? roots : null;
}

function ownerFor(
  stack: Array<{ indent: number; node: LumaParamNode }>,
  indent: number
): LumaParamNode | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].indent < indent) return stack[i].node;
  }
  return null;
}

/** Look up a node by dotted path, e.g. "video.edit.strength". */
export function findParam(tree: LumaParamNode[], path: string): LumaParamNode | null {
  const parts = path.split(".");
  let level: LumaParamNode[] | undefined = tree;
  let found: LumaParamNode | null = null;
  for (const part of parts) {
    if (!level) return null;
    found = level.find((n) => n.name === part) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

/**
 * Enum members for a dotted path.
 *
 * Falls back to parsing them out of the typespec itself — the generator writes
 * short inline unions as `optional "png" or "jpeg"` and only lists child
 * bullets for some of them. Returns null when the field has no enum at all, so
 * "not an enum" stays distinguishable from "an enum with no members".
 */
export function parseEnum(tree: LumaParamNode[], path: string): string[] | null {
  const node = findParam(tree, path);
  if (!node) return null;
  if (node.enumValues?.length) return node.enumValues;
  const inline = [...node.typeSpec.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return inline.length ? inline : null;
}

/**
 * The model identifiers Luma documents.
 *
 * Deliberately read from the API reference's `model` field rather than the
 * models GUIDE's "At a glance" table: that table is display copy, and it
 * provably omits things — the word "layering" does not appear on that page at
 * all, though uni-1 supports it.
 */
export function parseModels(tree: LumaParamNode[]): string[] | null {
  return parseEnum(tree, "model");
}

/** The generation types Luma documents (image, image_edit, video, …). */
export function parseTypes(tree: LumaParamNode[]): string[] | null {
  return parseEnum(tree, "type");
}
