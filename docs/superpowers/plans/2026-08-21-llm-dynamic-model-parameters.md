# Per-Model LLM Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM node's controls, ranges and defaults come from the selected model, and send only the parameters that model accepts.

**Architecture:** OpenRouter's catalogue supplies the per-model parameter surface; Google's own endpoint overlays real ranges for Gemini; a declared per-family table covers misses. The result is emitted as `ModelParameter[]` from the **existing** `/api/models/[modelId]` route, so the existing `ModelParameters` renderer is reused unchanged.

**Tech Stack:** TypeScript, Next.js 16, Zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-llm-dynamic-model-parameters-design.md`

## Global Constraints

- Work directly on `develop`. No feature branches, no PRs.
- One logical task = one commit. Do not batch.
- `npx tsc --noEmit` and `npx vitest run` must pass before every commit.
- Baseline before starting: **2202 tests, 108 files**, all green.
- Cache TTLs: **48 hours for a hit, 1 hour for a miss.**
- The node must **never** render with no controls. A metadata outage degrades precision, never usability.
- A parameter value is **kept, never deleted**, when the selected model does not support it. Only sending is filtered.
- `tools`, `tool_choice` and `include_reasoning` are dropped from imported schemas.

---

## Deviation from the spec, deliberate

The spec proposed a new `/api/llm/models/[modelId]` route. While planning it turned out that `ProviderType` (`src/types/providers.ts:9`) **already includes** `"gemini" | "openai" | "anthropic"`, and `ModelParameters.tsx:145` already fetches `/api/models/${modelId}?provider=${provider}`.

So the existing route is extended instead. `ModelParameters.tsx` needs **zero changes**, and the disk cache, 48h TTL, warmer and stale-on-failure behaviour come for free. The node's `LLMProvider` value `"google"` maps to the `ProviderType` value `"gemini"` at the call site.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/llm/openrouterCatalogue.ts` | fetch + cache the catalogue, index by id | **create** |
| `src/lib/llm/resolveModelId.ts` | native id → catalogue entry | **create** |
| `src/lib/llm/llmParameterSchema.ts` | entry (+ Google meta) → `ModelParameter[]`; family fallback | **create** |
| `src/app/api/llm/models/route.ts` | stop discarding Google's metadata; export a lookup | modify |
| `src/app/api/models/[modelId]/route.ts` | serve gemini/openai/anthropic | modify |
| `src/store/utils/llmNodeMigration.ts` | move the 3 typed fields into `parameters` | modify |
| `src/components/nodes/LLMGenerateNode.tsx` | swap fixed controls for `ModelParameters` | modify |
| `src/store/execution/llmGenerateExecutor.ts` | send only declared parameters | modify |
| `src/app/api/llm/route.ts` | map generic names to provider-native | modify |

---

## Task 1: OpenRouter catalogue

**Files:**
- Create: `src/lib/llm/openrouterCatalogue.ts`
- Create: `src/lib/llm/__tests__/openrouterCatalogue.test.ts`

**Interfaces:**
- Produces: `getOpenRouterCatalogue(): Promise<Map<string, OpenRouterEntry>>`, `clearOpenRouterCache(): void`, `type OpenRouterEntry = { id: string; supportedParameters: string[]; contextLength: number | null; maxCompletionTokens: number | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getOpenRouterCatalogue, clearOpenRouterCache } from "../openrouterCatalogue";

const payload = {
  data: [
    {
      id: "openai/gpt-4.1",
      context_length: 1047576,
      top_provider: { max_completion_tokens: 32768 },
      supported_parameters: ["max_tokens", "seed", "temperature", "top_p"],
    },
    {
      id: "openai/o3",
      context_length: 200000,
      top_provider: { max_completion_tokens: 100000 },
      supported_parameters: ["max_tokens", "reasoning", "seed"],
    },
  ],
};

describe("getOpenRouterCatalogue", () => {
  beforeEach(() => { clearOpenRouterCache(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("indexes entries by id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const cat = await getOpenRouterCatalogue();
    expect(cat.get("openai/gpt-4.1")?.supportedParameters).toContain("temperature");
    expect(cat.get("openai/o3")?.supportedParameters).not.toContain("temperature");
    expect(cat.get("openai/o3")?.maxCompletionTokens).toBe(100000);
  });

  it("fetches once and serves the cache for 48 hours", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await getOpenRouterCatalogue();
    vi.advanceTimersByTime(47 * 60 * 60 * 1000);
    await getOpenRouterCatalogue();
    expect(f).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    await getOpenRouterCatalogue();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("serves a STALE catalogue rather than failing when a refresh errors", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockRejectedValueOnce(new Error("network"));
    vi.stubGlobal("fetch", f);
    await getOpenRouterCatalogue();
    vi.advanceTimersByTime(49 * 60 * 60 * 1000);
    const cat = await getOpenRouterCatalogue();
    expect(cat.get("openai/gpt-4.1")).toBeDefined();
  });

  it("returns an empty map when the very first fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const cat = await getOpenRouterCatalogue();
    expect(cat.size).toBe(0);
  });

  it("skips entries with no supported_parameters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "x/y" }, ...payload.data] }), { status: 200 })));
    const cat = await getOpenRouterCatalogue();
    expect(cat.has("x/y")).toBe(false);
    expect(cat.size).toBe(2);
  });

  it("does not fire a second fetch while one is in flight", async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", f);
    const a = getOpenRouterCatalogue();
    const b = getOpenRouterCatalogue();
    resolve(new Response(JSON.stringify(payload), { status: 200 }));
    await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/llm/__tests__/openrouterCatalogue.test.ts`. Expected: cannot resolve module.

- [ ] **Step 3: Implement**

```ts
const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const HIT_TTL_MS = 48 * 60 * 60 * 1000;

export interface OpenRouterEntry {
  id: string;
  supportedParameters: string[];
  contextLength: number | null;
  maxCompletionTokens: number | null;
}

let cache: { at: number; entries: Map<string, OpenRouterEntry> } | null = null;
let inFlight: Promise<Map<string, OpenRouterEntry>> | null = null;

export function clearOpenRouterCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * The whole catalogue in ONE request (~420 models, ~690KB), indexed by id.
 * Cheaper than the per-model schema fetches the image/video route makes.
 *
 * A stale cache is served in preference to failing — the same rule
 * /api/models/[modelId] already follows. Losing precision beats losing the
 * node's controls.
 */
export async function getOpenRouterCatalogue(): Promise<Map<string, OpenRouterEntry>> {
  const fresh = cache && Date.now() - cache.at < HIT_TTL_MS;
  if (cache && fresh) return cache.entries;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(CATALOGUE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`OpenRouter catalogue: ${res.status}`);
      const json = await res.json();
      const entries = new Map<string, OpenRouterEntry>();
      for (const m of json?.data ?? []) {
        if (!Array.isArray(m?.supported_parameters) || m.supported_parameters.length === 0) continue;
        entries.set(m.id, {
          id: m.id,
          supportedParameters: m.supported_parameters,
          contextLength: typeof m.context_length === "number" ? m.context_length : null,
          maxCompletionTokens:
            typeof m?.top_provider?.max_completion_tokens === "number"
              ? m.top_provider.max_completion_tokens
              : null,
        });
      }
      cache = { at: Date.now(), entries };
      return entries;
    } catch {
      // Stale beats nothing; nothing beats throwing.
      return cache?.entries ?? new Map<string, OpenRouterEntry>();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
```

- [ ] **Step 4: Run to verify it passes** — expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cached OpenRouter model catalogue"
```

---

## Task 2: Native id → catalogue entry

**Files:**
- Create: `src/lib/llm/resolveModelId.ts`
- Create: `src/lib/llm/__tests__/resolveModelId.test.ts`

**Interfaces:**
- Consumes: `OpenRouterEntry` from Task 1.
- Produces: `resolveOpenRouterEntry(provider: "google" | "openai" | "anthropic", modelId: string, catalogue: Map<string, OpenRouterEntry>): OpenRouterEntry | null`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveOpenRouterEntry } from "../resolveModelId";
import type { OpenRouterEntry } from "../openrouterCatalogue";

const e = (id: string): OpenRouterEntry => ({
  id, supportedParameters: ["temperature"], contextLength: null, maxCompletionTokens: null,
});
const cat = new Map<string, OpenRouterEntry>([
  ["openai/gpt-4.1", e("openai/gpt-4.1")],
  ["anthropic/claude-sonnet-4", e("anthropic/claude-sonnet-4")],
  ["google/gemini-2.5-flash", e("google/gemini-2.5-flash")],
]);

describe("resolveOpenRouterEntry", () => {
  it("matches an exact namespaced id", () => {
    expect(resolveOpenRouterEntry("openai", "gpt-4.1", cat)?.id).toBe("openai/gpt-4.1");
  });

  it("maps the google provider onto the google namespace", () => {
    expect(resolveOpenRouterEntry("google", "gemini-2.5-flash", cat)?.id).toBe("google/gemini-2.5-flash");
  });

  it("strips a trailing date stamp", () => {
    expect(resolveOpenRouterEntry("anthropic", "claude-sonnet-4-20250514", cat)?.id)
      .toBe("anthropic/claude-sonnet-4");
  });

  it("strips -preview and -latest", () => {
    expect(resolveOpenRouterEntry("google", "gemini-2.5-flash-preview", cat)?.id)
      .toBe("google/gemini-2.5-flash");
    expect(resolveOpenRouterEntry("google", "gemini-2.5-flash-latest", cat)?.id)
      .toBe("google/gemini-2.5-flash");
  });

  it("falls back to the longest family prefix within the provider", () => {
    // An unreleased point version should inherit its family, not miss entirely.
    expect(resolveOpenRouterEntry("anthropic", "claude-sonnet-4-9-turbo", cat)?.id)
      .toBe("anthropic/claude-sonnet-4");
  });

  it("never matches across providers", () => {
    expect(resolveOpenRouterEntry("openai", "claude-sonnet-4", cat)).toBeNull();
  });

  it("returns null for a total miss", () => {
    expect(resolveOpenRouterEntry("openai", "totally-new-thing", cat)).toBeNull();
  });

  it("returns null on an empty catalogue rather than throwing", () => {
    expect(resolveOpenRouterEntry("openai", "gpt-4.1", new Map())).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
import type { OpenRouterEntry } from "./openrouterCatalogue";

/** The node's LLMProvider values map onto OpenRouter's namespaces. */
const NAMESPACE: Record<string, string> = {
  google: "google",
  openai: "openai",
  anthropic: "anthropic",
};

/**
 * Ordered resolution, first match wins. Vendors ship dated and preview ids that
 * OpenRouter lists under a stable name, and brand-new point releases are not
 * listed at all — the family prefix keeps those working with their family's
 * parameter set rather than dropping to the declared fallback.
 */
export function resolveOpenRouterEntry(
  provider: "google" | "openai" | "anthropic",
  modelId: string,
  catalogue: Map<string, OpenRouterEntry>,
): OpenRouterEntry | null {
  const ns = NAMESPACE[provider];
  if (!ns || catalogue.size === 0) return null;

  const candidates = [
    modelId,
    modelId.replace(/-\d{8}$/, ""),          // claude-sonnet-4-20250514
    modelId.replace(/-(preview|latest)$/, ""),
  ];
  for (const c of candidates) {
    const hit = catalogue.get(`${ns}/${c}`);
    if (hit) return hit;
  }

  // Longest prefix within this provider's namespace only — a cross-provider
  // match would hand Claude's parameters to a GPT model.
  let best: OpenRouterEntry | null = null;
  for (const [id, entry] of catalogue) {
    if (!id.startsWith(`${ns}/`)) continue;
    const bare = id.slice(ns.length + 1);
    if (!modelId.startsWith(bare)) continue;
    if (!best || bare.length > best.id.length - ns.length - 1) best = entry;
  }
  return best;
}
```

- [ ] **Step 4: Run to verify it passes** — expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: resolve native LLM model ids to catalogue entries"
```

---

## Task 3: Translation and family fallback

**Files:**
- Create: `src/lib/llm/llmParameterSchema.ts`
- Create: `src/lib/llm/__tests__/llmParameterSchema.test.ts`

**Interfaces:**
- Consumes: `OpenRouterEntry` (Task 1).
- Produces: `toModelParameters(entry: OpenRouterEntry | null, google?: GoogleModelMeta | null): ModelParameter[]`, `familyFallback(provider, modelId): ModelParameter[]`, `type GoogleModelMeta = { temperature?: number; maxTemperature?: number; topP?: number; topK?: number; outputTokenLimit?: number; thinking?: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { toModelParameters, familyFallback } from "../llmParameterSchema";
import type { OpenRouterEntry } from "../openrouterCatalogue";

const entry = (params: string[], extra: Partial<OpenRouterEntry> = {}): OpenRouterEntry => ({
  id: "x/y", supportedParameters: params, contextLength: null, maxCompletionTokens: null, ...extra,
});
const names = (ps: ReturnType<typeof toModelParameters>) => ps.map((p) => p.name);

describe("toModelParameters", () => {
  it("translates OpenRouter names to the node's", () => {
    const ps = toModelParameters(entry(["temperature", "top_p", "top_k", "seed", "stop"]));
    expect(names(ps)).toEqual(["temperature", "topP", "topK", "seed", "stopSequences"]);
  });

  it("maps both max-token spellings onto maxTokens, once", () => {
    const ps = toModelParameters(entry(["max_tokens", "max_completion_tokens"]));
    expect(names(ps)).toEqual(["maxTokens"]);
  });

  it("maps reasoning and reasoning_effort onto one reasoning control", () => {
    expect(names(toModelParameters(entry(["reasoning"])))).toEqual(["reasoning"]);
    expect(names(toModelParameters(entry(["reasoning_effort"])))).toEqual(["reasoning"]);
  });

  it("drops tools, tool_choice and include_reasoning", () => {
    const ps = toModelParameters(entry(["tools", "tool_choice", "include_reasoning", "temperature"]));
    expect(names(ps)).toEqual(["temperature"]);
  });

  it("ignores an unknown OpenRouter parameter rather than rendering it raw", () => {
    expect(names(toModelParameters(entry(["temperature", "quantum_flux"])))).toEqual(["temperature"]);
  });

  it("omits temperature entirely for a model that does not accept it", () => {
    // o3 is the real case this exists for.
    expect(names(toModelParameters(entry(["max_tokens", "reasoning"])))).not.toContain("temperature");
  });

  it("takes the maxTokens ceiling from the catalogue", () => {
    const ps = toModelParameters(entry(["max_tokens"], { maxCompletionTokens: 100000 }));
    expect(ps.find((p) => p.name === "maxTokens")?.maximum).toBe(100000);
  });

  it("lets Google's own numbers win over the catalogue", () => {
    const ps = toModelParameters(entry(["temperature", "max_tokens"], { maxCompletionTokens: 8192 }), {
      temperature: 1, maxTemperature: 2, outputTokenLimit: 65536,
    });
    const t = ps.find((p) => p.name === "temperature")!;
    expect(t.default).toBe(1);
    expect(t.maximum).toBe(2);
    expect(ps.find((p) => p.name === "maxTokens")?.maximum).toBe(65536);
  });

  it("removes the reasoning control when Google says the model does not think", () => {
    const ps = toModelParameters(entry(["reasoning"]), { thinking: false });
    expect(names(ps)).not.toContain("reasoning");
  });

  it("returns an empty list for a null entry — the caller falls back", () => {
    expect(toModelParameters(null)).toEqual([]);
  });
});

describe("familyFallback", () => {
  it("gives o-series reasoning and max tokens but NOT temperature", () => {
    const ps = familyFallback("openai", "o3-mini");
    expect(names(ps)).toContain("reasoning");
    expect(names(ps)).not.toContain("temperature");
  });

  it("gives gpt-* temperature and max tokens", () => {
    expect(names(familyFallback("openai", "gpt-5-turbo"))).toEqual(
      expect.arrayContaining(["temperature", "maxTokens"]));
  });

  it("always returns at least maxTokens, for any unknown model", () => {
    expect(names(familyFallback("openai", "something-unheard-of"))).toContain("maxTokens");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — a `TRANSLATE` record mapping each OpenRouter name to a `ModelParameter` builder, applied in a stable order (`temperature`, `topP`, `topK`, `maxTokens`, `seed`, `stopSequences`, `reasoning`, `responseFormat`, `verbosity`), de-duplicated by name so both max-token spellings collapse to one. The Google overlay is applied after translation. `familyFallback` returns the declared set for `/^o\d/`, `/^gpt-/`, `/^claude-/`, `/^gemini-/`, and `[maxTokens]` for anything else.

- [ ] **Step 4: Run to verify it passes** — expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: translate OpenRouter parameters into ModelParameter[]"
```

---

## Task 4: Keep Google's metadata

**Files:**
- Modify: `src/app/api/llm/models/route.ts:67-79` (the `GoogleModel` type and `.map()` that discards everything)
- Create: `src/app/api/llm/models/__tests__/googleMeta.test.ts`

**Interfaces:**
- Produces: `getGoogleModelMeta(modelId: string): Promise<GoogleModelMeta | null>`, and `ModelEntry` gains an optional `meta?: GoogleModelMeta`.

- [ ] **Step 1: Write the failing test** — a mocked Google response carrying `temperature: 1, maxTemperature: 2, topP: 0.95, topK: 64, outputTokenLimit: 65536, thinking: true` for `models/gemini-2.5-flash` must come back from `getGoogleModelMeta("gemini-2.5-flash")` with those exact values; an unknown id returns null; a failed fetch returns null rather than throwing.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — widen the `GoogleModel` type to include `temperature`, `topP`, `topK`, `maxTemperature`, `inputTokenLimit`, `outputTokenLimit`, `thinking`, and carry them onto each `ModelEntry` as `meta`. These fields are already in the response and were being thrown away; this only stops discarding them.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: keep Google's per-model parameter metadata"
```

---

## Task 5: Serve LLM schemas from the existing route

**Files:**
- Modify: `src/app/api/models/[modelId]/route.ts`
- Create: `src/app/api/models/[modelId]/__tests__/llmSchema.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `GET /api/models/{modelId}?provider=gemini|openai|anthropic` → the same `SchemaSuccessResponse` shape the image/video providers return.

- [ ] **Step 1: Write the failing test** — `?provider=openai&modelId=o3` returns parameters without `temperature`; `?provider=gemini&modelId=gemini-2.5-flash` returns `maxTokens.maximum === 65536` from the Google overlay; an unresolvable id returns the family fallback with `success: true` (never a 404, never an empty parameter list); a catalogue outage still returns the fallback.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — add an LLM branch before the existing provider dispatch: resolve the entry, translate, overlay Google, fall back to the family table when the entry is null. Cache a **miss** for 1 hour and a **hit** for 48, per the global constraints.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: /api/models serves per-model LLM parameter schemas"
```

---

## Task 6: Migrate the three typed fields

**Files:**
- Modify: `src/store/utils/llmNodeMigration.ts`
- Modify: `src/store/utils/__tests__/llmNodeMigration.test.ts`
- Modify: `src/types/nodes.ts` (`LLMGenerateNodeData`: add `parameters?: Record<string, unknown>`; deprecate `temperature`, `maxTokens`, `reasoning`)

**Interfaces:**
- Consumes: the existing `migrateLlmNodes(nodes, edges)`.

- [ ] **Step 1: Write the failing test**

```ts
it("moves temperature, maxTokens and reasoning into parameters", () => {
  const { nodes } = migrateLlmNodes(
    [llm({ temperature: 0.7, maxTokens: 8192, reasoning: "low" })], []);
  expect(dataOf(nodes[0]).parameters).toEqual({ temperature: 0.7, maxTokens: 8192, reasoning: "low" });
});

it("leaves an already-migrated node alone", () => {
  const once = migrateLlmNodes([llm({ temperature: 0.5 })], []);
  const twice = migrateLlmNodes(once.nodes, once.edges);
  expect(twice.nodes[0].data).toEqual(once.nodes[0].data);
});

it("does not invent parameters for a node that had none", () => {
  const { nodes } = migrateLlmNodes([llm({ rememberTurns: true })], []);
  expect(dataOf(nodes[0]).parameters ?? {}).toEqual({});
});

it("keeps an existing parameters bag and does not overwrite it", () => {
  const { nodes } = migrateLlmNodes(
    [llm({ temperature: 0.7, parameters: { topP: 0.9 } })], []);
  expect(dataOf(nodes[0]).parameters).toEqual({ topP: 0.9 });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — inside the existing per-node map, when any of the three fields is present and `parameters` is absent, move them across and delete the originals. Guarded on `parameters` being absent, which is what makes it idempotent.

- [ ] **Step 4: Run to verify it passes** — plus the existing 15 migration tests still green.

- [ ] **Step 5: Manual check** — open `01_25/03` and confirm its LLM node keeps its settings.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: LLM parameters move into a generic bag"
```

---

## Task 7: Node UI and executor filtering

**Files:**
- Modify: `src/components/nodes/LLMGenerateNode.tsx` (delete the Temperature / Max Tokens / Reasoning controls **and** the hardcoded Anthropic clamp)
- Modify: `src/store/execution/llmGenerateExecutor.ts`
- Modify: `src/app/api/llm/route.ts`
- Modify: `src/store/execution/__tests__/llmGenerateExecutor.test.ts`

**Interfaces:**
- Consumes: `ModelParameters` (`src/components/nodes/ModelParameters.tsx`), unchanged, with `provider={nodeData.provider === "google" ? "gemini" : nodeData.provider}`.

- [ ] **Step 1: Write the failing test** — the executor sends only keys the model declares: with a schema lacking `temperature`, a node whose `parameters` still holds `temperature: 0.7` must produce a request body **without** it, while `parameters` in node data keeps the value.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — render `<ModelParameters modelId={nodeData.model} provider={...} parameters={nodeData.parameters ?? {}} onParametersChange={(p) => updateNodeData(id, { parameters: p })} />`; the executor filters `parameters` against the fetched schema before building the body; `/api/llm` maps the generic names to each provider's native ones.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Manual check** — select `gpt-4.1` and confirm Temperature appears; switch to an o-series model and confirm it disappears; switch back and confirm the value returns.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: LLM node controls follow the selected model"
```

---

## Self-Review

**Spec coverage.** §1 sources → Tasks 1, 3, 4. §Id resolution → Task 2. §2 caching → Tasks 1, 5. §3 emitted schema → Task 3, rendered via Task 7. §4 storage/migration → Task 6. §5 what is sent → Task 7. §6 testing → distributed. No gaps.

**Deviation, recorded above:** the spec's new `/api/llm/models/[modelId]` route is replaced by extending `/api/models/[modelId]`, because `ProviderType` already carries the three LLM providers and `ModelParameters` already targets that URL. This deletes a whole file from the plan and means the renderer needs no change.

**Type consistency.** `OpenRouterEntry` is produced in Task 1 and consumed under that name in Tasks 2 and 3. `GoogleModelMeta` is defined in Task 3 and produced by Task 4. `toModelParameters` / `familyFallback` / `resolveOpenRouterEntry` keep the same signatures wherever referenced. Parameter names — `temperature`, `topP`, `topK`, `maxTokens`, `seed`, `stopSequences`, `reasoning`, `responseFormat`, `verbosity` — are identical in Tasks 3, 6 and 7.
