# LLM node: per-model parameters

**Date:** 2026-08-21
**Status:** approved, not yet implemented

## Problem

The LLM Generate node shows one fixed set of controls — Temperature, Max Tokens,
Reasoning — for every model of every provider. That is wrong in three separate
ways, and each has been verified against the live APIs rather than assumed.

**It shows parameters the model rejects.** OpenRouter's catalogue lists the
parameters each model actually accepts. `openai/o3` does not accept
`temperature` at all; `anthropic/claude-opus-5-fast` accepts neither
`temperature` nor `top_p` but does accept `reasoning_effort` and `verbosity`.
The node offers Temperature for all of them and sends it, so the request is
either rejected or the value silently ignored.

**It hides parameters the model has.** `gemini-2.5-flash` accepts `top_p`,
`top_k`, `seed` and `stop`; `gpt-4.1` accepts `seed`, `top_p` and
`response_format`. None are reachable from the node.

**Its numbers are guesses.** Max Tokens defaults to 8192 with a hardcoded
ceiling. Google's own endpoint reports `outputTokenLimit: 65536` for
`gemini-2.5-flash` — the node under-serves the model by 8x. Likewise the
hardcoded "Anthropic clamps temperature to 1" special case
(`LLMGenerateNode.tsx`) is a per-vendor guess standing in for per-model truth.

Meanwhile `/api/llm/models` already calls Google's models endpoint and
**discards every field except `id` and `label`** — including
`temperature`, `topP`, `topK`, `maxTemperature`, `inputTokenLimit`,
`outputTokenLimit` and `thinking`, all of which are per-model and authoritative.

## Goals

Each model's controls, ranges and defaults come from that model, and only
parameters it declares are sent.

## Non-goals

- Tool calling. `tools` / `tool_choice` are dropped from the imported schema;
  the node has no tool-calling support and this does not add it.
- Routing generation through a proxy. Calls stay native — see below.

---

## Why not the generator-node mechanism

The obvious move is to reuse `/api/models/[modelId]`, which serves
`ModelParameter[]` for image and video models. It does not work here, and the
reason is worth recording so it is not revisited.

**Replicate** hosts 46 models in its `language-models` collection, 45 with
per-model OpenAPI schemas — the same machinery. But those schemas describe
*Replicate's wrapper*, not the vendor API. `anthropic/claude-3.7-sonnet` on
Replicate exposes exactly five parameters: `image`, `prompt`, `max_tokens`,
`system_prompt`, `max_image_resolution`. No temperature, no top_p. Adopting it
would make the node **less** accurate than it is today, while adding a proxy
margin to calls we currently make directly.

**fal** lists 9 models in its `llm` category. The only general-purpose one is
`openrouter/router` — a single chat endpoint where the model is a *parameter*,
so it carries one schema for every model. That is the unified-parameter problem
relocated, not solved.

Routing LLM traffic through fal or Replicate remains a reasonable idea for
*reach* — one catalogue, one bill, models otherwise out of reach. It is a
separate feature and does not belong in this one.

---

## 1 · Where the metadata comes from

### Primary: OpenRouter's catalogue

`GET https://openrouter.ai/api/v1/models`, no authentication required for the
listing. Measured: 420 models, 417 (99%) carrying `supported_parameters`,
687 KB for the whole document.

Three fields are used:

| field | used for |
|---|---|
| `supported_parameters[]` | which controls exist for this model |
| `context_length` | input budget, shown as a read-only note |
| `top_provider.max_completion_tokens` | the Max Tokens ceiling |

It is **one fetch for the entire catalogue**, indexed by id — not one request
per model like the generator schema route.

### Overlay: Google's own endpoint, for Gemini

`/api/llm/models` already fetches it. Stop discarding the rest of each entry and
overlay these onto the OpenRouter result for Google models, because the vendor
is authoritative for its own ranges:

- `temperature` → default, `maxTemperature` → maximum
- `topP`, `topK` → defaults
- `outputTokenLimit` → Max Tokens maximum
- `inputTokenLimit` → context note
- `thinking` → whether the Reasoning control appears

Where Google and OpenRouter disagree, **Google wins for Google models**.

### Fallback: declared families

When the fetch fails or an id cannot be resolved, a small table keyed by pattern
— `/^o\d/`, `/^gpt-/`, `/^claude-/`, `/^gemini-/` — supplies a sane control set.

**The node must never render with no controls.** A metadata outage degrades the
precision of the ranges, never the ability to use the node.

### Id resolution

Native ids are bare (`gpt-4.1`); OpenRouter's are namespaced
(`openai/gpt-4.1`). Resolution is ordered, first match wins:

1. `provider/id` exactly
2. date suffix stripped — `claude-x-20250101` → `claude-x`
3. `-preview` / `-latest` suffix stripped
4. longest family-prefix match within the provider
5. declared fallback

---

## 2 · Caching

Mirrors the existing schema cache rather than introducing a second policy:
48-hour TTL, refreshed by the warmer, and **a stale entry is served in
preference to failing** — the behaviour `/api/models/[modelId]` already has.

One addition: **a cache miss gets its own short TTL of 1 hour.** A model that
shipped this morning is not in OpenRouter's catalogue yet; caching that absence
for 48 hours would pin it to family defaults for two days after OpenRouter
adds it. An hour keeps it fresh without hammering the endpoint.

`useLlmModelLists`'s existing `refresh` clears the parameter cache too, so a
model known to have just landed does not require waiting out a TTL.

Note the model **list** does not depend on OpenRouter at all — it comes from the
vendors' own endpoints. A brand-new model appears in the dropdown the day it
ships regardless; only the precision of its parameters lags.

---

## 3 · What is emitted

`ModelParameter[]` — the exact type in `src/lib/providers/types.ts` that image
and video models already use, so **`ModelParameters.tsx` renders it with no new
component**.

OpenRouter's names are translated to the node's:

| OpenRouter | node | note |
|---|---|---|
| `temperature` | `temperature` | range from Google where available, else 0–2 |
| `top_p` | `topP` | 0–1 |
| `top_k` | `topK` | integer |
| `max_tokens`, `max_completion_tokens` | `maxTokens` | ceiling from `top_provider` / `outputTokenLimit` |
| `stop` | `stopSequences` | string array |
| `seed` | `seed` | integer |
| `reasoning`, `reasoning_effort` | `reasoning` | existing off/low/medium/high |
| `response_format`, `structured_outputs` | `responseFormat` | enum: text / json |
| `verbosity` | `verbosity` | enum, Anthropic |
| `tools`, `tool_choice` | — | dropped, out of scope |
| `include_reasoning` | — | dropped, an OpenRouter-ism |

---

## 4 · Storage and migration

`temperature`, `maxTokens` and `reasoning` stop being typed fields on
`LLMGenerateNodeData` and become entries in
`parameters?: Record<string, unknown>` — the same shape every generator node
already uses.

Migration runs in `migrateLlmNodes`, which already exists and already runs on
load, so no new mechanism:

```
{ temperature: 0.7, maxTokens: 8192, reasoning: "low" }
  → { parameters: { temperature: 0.7, maxTokens: 8192, reasoning: "low" } }
```

Idempotent, like the rest of that function: a node already carrying
`parameters` is left alone. Affects 23 LLM nodes across 11 saved workflows.

A value in `parameters` that the newly-selected model does not support is
**kept, not deleted**. Switching from `gpt-4.1` to `o3` hides Temperature; it
does not discard it, so switching back restores what you had. Only supported
parameters are *sent*.

---

## 5 · What gets sent

`/api/llm` receives the `parameters` bag and forwards **only keys the selected
model declares**, mapped to each provider's native names. This is where the
correctness win actually lands: `o3` no longer receives `temperature` because it
is not in that model's declared set, rather than because of a special case in
the UI.

The hardcoded Anthropic temperature clamp in `LLMGenerateNode.tsx` is deleted —
the model's own declared maximum replaces it.

---

## 6 · Testing

`vitest`. Network is mocked; the fixtures are trimmed copies of real responses
captured from OpenRouter and Google during this design, so they cannot drift
into fiction.

**Id resolution** — exact hit; date-suffixed; `-preview`; family prefix; total
miss falling through to the declared table. This has the most branches and the
most room for a wrong guess.

**Translation** — every row of the table above; `tools`/`include_reasoning`
dropped; an unknown OpenRouter parameter ignored rather than rendered raw.

**Google overlay** — `maxTemperature` beats OpenRouter's default range;
`outputTokenLimit` sets the Max Tokens ceiling; `thinking: false` removes the
Reasoning control; the overlay applies to Google models only.

**Caching** — a hit caches for 48h, a miss for 1h; a failed refresh serves the
stale entry instead of failing; `refresh` clears both caches.

**Migration** — the three fields move into `parameters`; idempotent; a node
already migrated is untouched.

**Executor** — only declared keys are sent; an unsupported value in
`parameters` is retained in node data but omitted from the request.

---

## Risks

**A third party now shapes the controls.** The fallback and stale-serving cover
outages, but on a cold cache with no network you get family defaults rather than
exact per-model values. Accepted: the alternative sources were measured and are
worse.

**OpenRouter describes its own proxy surface.** Usually a faithful reflection of
the vendor API, but not guaranteed — `include_reasoning` and
`max_completion_tokens` are their vocabulary. The translation table is the seam
where that is corrected, and the Google overlay demonstrates the pattern for
fixing any provider where their view proves wrong.

**Parameters become dynamic, so a saved workflow can render differently later**
if a model's declared set changes. Values are never deleted, so the stored
configuration survives; only its visibility moves.
