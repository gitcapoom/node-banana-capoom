/**
 * Generic OpenAPI schema → NormalizedSchema.
 *
 * Key improvements over the legacy `resolvePropertyType` approach:
 *   - anyOf / oneOf: preserves ALL non-null variants as unionVariants (legacy picked one)
 *   - allOf: merges all referenced schemas (enum + default + description)
 *   - $ref: resolved inline; recursive refs are safely skipped
 *   - Nullable anyOf: `[T, null]` → single T type with nullable=true flag
 *   - pydantic ge/le/gt/lt → minimum/maximum (OpenAPI convention)
 *   - exclusiveMinimum/Maximum numeric values (OpenAPI 3.1) → min/max adjusted
 */

import type { NormalizedSchema, NormalizedProperty } from "../types";

/**
 * Parse `#/components/schemas/Name` → the resolved object.
 */
function resolveRef(
  ref: string,
  components: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!components) return null;
  const parts = ref.replace(/^#\//, "").split("/");
  // Expected format: components/schemas/Name
  let cursor: unknown = { components: { schemas: components } };
  for (const p of parts) {
    if (cursor && typeof cursor === "object" && p in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return (cursor && typeof cursor === "object") ? (cursor as Record<string, unknown>) : null;
}

/**
 * Normalize a raw OpenAPI property (may contain $ref, anyOf, oneOf, allOf) into
 * the flat NormalizedProperty shape.
 *
 * `seen` tracks $ref names currently being resolved to prevent infinite recursion.
 */
export function normalizeProperty(
  name: string,
  raw: Record<string, unknown>,
  components?: Record<string, unknown>,
  seen: Set<string> = new Set(),
  source: NormalizedProperty["source"] = "openapi"
): NormalizedProperty {
  // --- 1. $ref at top-level: resolve and merge (local fields override ref'd) ---
  if (typeof raw.$ref === "string" && components) {
    if (seen.has(raw.$ref)) {
      // Recursive — treat as plain string
      return { name, type: "string", source, description: (raw.description as string) };
    }
    const resolved = resolveRef(raw.$ref, components);
    if (resolved) {
      const nextSeen = new Set(seen);
      nextSeen.add(raw.$ref);
      const merged = { ...resolved, ...raw };
      delete (merged as Record<string, unknown>).$ref;
      return normalizeProperty(name, merged, components, nextSeen, source);
    }
  }

  // --- 2. allOf: merge all members (last-write-wins, excluding type overrides from null) ---
  const allOf = raw.allOf as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(allOf) && allOf.length > 0) {
    let merged: Record<string, unknown> = { ...raw };
    delete merged.allOf;
    for (const member of allOf) {
      const resolvedMember = (typeof member.$ref === "string" && components && !seen.has(member.$ref))
        ? (() => {
            const r = resolveRef(member.$ref as string, components);
            return r ? { ...r, ...member } : member;
          })()
        : member;
      // Merge enum, description, default from member; don't overwrite local fields
      if (Array.isArray(resolvedMember.enum) && !merged.enum) merged.enum = resolvedMember.enum;
      if (resolvedMember.default !== undefined && merged.default === undefined) merged.default = resolvedMember.default;
      if (resolvedMember.description && !merged.description) merged.description = resolvedMember.description;
      if (resolvedMember.type && !merged.type) merged.type = resolvedMember.type;
      if (resolvedMember.format && !merged.format) merged.format = resolvedMember.format;
      // Carry over properties and items if present on member (for object/array allOf patterns)
      if (resolvedMember.properties && !merged.properties) merged.properties = resolvedMember.properties;
      if (resolvedMember.items && !merged.items) merged.items = resolvedMember.items;
    }
    const nextSeen = new Set(seen);
    return normalizeProperty(name, merged, components, nextSeen, source);
  }

  // --- 3. anyOf / oneOf: detect nullable (T | null) vs true union ---
  const variants = (raw.anyOf ?? raw.oneOf) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const nonNullVariants: Array<Record<string, unknown>> = [];
    let nullable = false;
    for (const v of variants) {
      if (v.type === "null") {
        nullable = true;
      } else {
        nonNullVariants.push(v);
      }
    }

    // Resolve each non-null variant (may itself have $ref)
    const nextSeen = new Set(seen);
    const normalizedVariants = nonNullVariants.map((v) =>
      normalizeProperty(name, v, components, nextSeen, source)
    );

    if (normalizedVariants.length === 0) {
      // Empty union, treat as string
      return { name, type: "string", source, nullable: true };
    }

    if (normalizedVariants.length === 1) {
      // Nullable-of-T pattern — flatten to T with nullable flag
      const [only] = normalizedVariants;
      return {
        ...only,
        name,
        nullable,
        // Preserve top-level description/default from raw
        description: (raw.description as string) ?? only.description,
        default: raw.default ?? only.default,
      };
    }

    // True union — preserve all variants
    return {
      name,
      type: "union",
      description: raw.description as string | undefined,
      default: raw.default,
      unionVariants: normalizedVariants,
      nullable,
      source,
    };
  }

  // --- 4. Direct type ---
  const declaredType = raw.type as string | undefined;
  const typ: NormalizedProperty["type"] =
    declaredType === "integer" ? "integer" :
    declaredType === "number" ? "number" :
    declaredType === "boolean" ? "boolean" :
    declaredType === "array" ? "array" :
    declaredType === "object" ? "object" :
    "string"; // default

  const out: NormalizedProperty = {
    name,
    type: typ,
    description: raw.description as string | undefined,
    format: raw.format as string | undefined,
    default: raw.default,
    source,
  };

  // Enum
  if (Array.isArray(raw.enum) && raw.enum.length > 0) out.enum = raw.enum;

  // Numeric constraints: OpenAPI min/max + Pydantic ge/le/gt/lt
  const min =
    raw.minimum ??
    raw.ge ??
    (typeof raw.exclusiveMinimum === "number" ? (raw.exclusiveMinimum as number) + 1 : undefined) ??
    (typeof raw.gt === "number" ? (raw.gt as number) + (typ === "integer" ? 1 : 0.01) : undefined);
  const max =
    raw.maximum ??
    raw.le ??
    (typeof raw.exclusiveMaximum === "number" ? (raw.exclusiveMaximum as number) - 1 : undefined) ??
    (typeof raw.lt === "number" ? (raw.lt as number) - (typ === "integer" ? 1 : 0.01) : undefined);
  if (typeof min === "number") out.minimum = min;
  if (typeof max === "number") out.maximum = max;

  // Object sub-properties
  if (typ === "object") {
    const objProps = raw.properties as Record<string, Record<string, unknown>> | undefined;
    if (objProps) {
      const subRequired = Array.isArray(raw.required) ? (raw.required as string[]) : [];
      const properties: Record<string, NormalizedProperty> = {};
      for (const [subName, subRaw] of Object.entries(objProps)) {
        const normSub = normalizeProperty(subName, subRaw, components, seen, source);
        if (subRequired.includes(subName)) normSub.required = true;
        properties[subName] = normSub;
      }
      out.properties = properties;
    }
  }

  // Array items
  if (typ === "array") {
    const itemsRaw = raw.items as Record<string, unknown> | undefined;
    if (itemsRaw) {
      out.items = normalizeProperty("item", itemsRaw, components, seen, source);
    }
  }

  return out;
}

/**
 * Normalize the top-level "Input" schema object from an OpenAPI spec.
 *
 * @param schema - The raw schema object (typically `components.schemas.Input` or similar)
 * @param components - `components.schemas` for $ref resolution
 */
export function normalizeOpenApiSchema(
  schema: Record<string, unknown>,
  components?: Record<string, unknown>
): NormalizedSchema {
  const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) || {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  const properties: Record<string, NormalizedProperty> = {};
  for (const [name, raw] of Object.entries(props)) {
    const normalized = normalizeProperty(name, raw, components, new Set(), "openapi");
    if (required.includes(name)) normalized.required = true;
    properties[name] = normalized;
  }

  return {
    properties,
    required,
    source: "openapi",
  };
}
