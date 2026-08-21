# LLM node: inline chat, generator-friendly prompts, and prompt nodes

**Date:** 2026-08-21
**Status:** approved, not yet implemented

## Problem

The LLM Generate node has three modes built from two booleans (`conversationMode`,
`loopbackMode`), and only one of them — loopback — can be driven from inside the
node. In the other two you must wire a prompt node into the text input, edit that
node, and run the graph, even when all you want is to ask a question.

Loopback, the one mode with an inline compose box, does not work as intended and
is being removed rather than fixed. Evidence that this is safe: across 17 readable
saved workflows containing **23 `llmGenerate` nodes, zero have `loopbackMode:true`**
(19 are conversation mode, 4 one-shot).

Separately, the node's reply is conversational prose. Feeding it to an image
generator means hand-stripping it every time, and there is no way to get it onto
the canvas as a prompt node without copy-paste.

## Goals

1. One chat node, driven inline, with an optional memory toggle.
2. Optionally derive a clean, generator-ready prompt (and a negative prompt) from
   the reply.
3. Optionally hold that prompt under a character budget.
4. Put the result on the canvas as a prompt node, on an explicit button press.

## Non-goals

- Any automatic node creation. Nothing appears on the canvas unless a button is
  pressed. This was an explicit decision.
- Any automatic triggering of downstream generator nodes. Loopback did this; it is
  not being carried forward.
- Changing what the node's `text` output emits. It stays the assistant's reply.

---

## 1. Mode model

`conversationMode` and `loopbackMode` are replaced by a single boolean:

```ts
/** When true the full transcript is sent on every Send. When false only the
 *  newest message is sent — the transcript is still kept and displayed, it is
 *  just not transmitted. */
rememberTurns?: boolean;
```

There is no mode selector. Every node is a chat node; the checkbox is labelled
**Remember previous turns**.

### Migration

Applied in `loadWorkflow` (`src/store/workflowStore.ts`), beside the existing
edge migration (`migrateEdgeHandles` / `conformEdgesToRenderablePins`):

| saved state | becomes |
|---|---|
| `conversationMode: false` / absent | `rememberTurns: false` |
| `conversationMode: true` | `rememberTurns: true` |
| `loopbackMode: true` | `rememberTurns: true` |

Loopback nodes keep their `conversation` array, so their transcript survives. The
loopback-only fields (`outputPrompt`, `lastLoopbackInput`, `composeInput` as a
loopback field, the pinned first-prompt anchor) are dropped; `composeInput` is
retained and generalised to every node as the compose box value.

Migration must be idempotent — running it twice produces the same result — because
workflows are loaded, saved and reloaded repeatedly.

### Removal surface

- `src/store/execution/loopbackSkill.ts` (79 lines) — delete
- `src/store/execution/__tests__/loopbackParse.test.ts` (49 lines) — delete
- Loopback branches in `src/app/api/llm/route.ts`, `src/store/utils/connectedInputs.ts`,
  `src/components/nodes/FloatingNodeHeader.tsx`
- Loopback handling in `ControlPanel.tsx`, `DynamicInputHandles.tsx`,
  `WorkflowCanvas.tsx`, `LLMGenerateNode.tsx`, `llmGenerateExecutor.ts`
- The fuchsia feedback image input and the second `prompt` output handle

Removing the feedback input and the `prompt` output orphans any edge attached to
them. **The existing conformance pass does not cover either case** — it was read
to confirm this, not assumed:

- `conformEdgesToRenderablePins` operates on *target* handles, so an edge whose
  **source** is the removed `prompt` output is outside its remit entirely.
- Its own rules state that `image-feedback` handles "are untouched", so the
  feedback input is explicitly exempted.

The migration must therefore drop these edges itself: on every `llmGenerate`
node, remove edges with `targetHandle === "image-feedback"` and edges with
`sourceHandle === "prompt"`. No saved workflow currently has either, so this
should be a no-op in practice — but an edge pointing at a handle that no longer
renders becomes an invisible ghost that still resolves into request bodies, which
is a bug class this codebase has already been bitten by.

---

## 2. Node body

The transcript + compose box + Send that loopback alone had becomes the standard
body for every LLM node.

- **Transcript** — existing `ConversationTranscript`, unchanged, always shown.
- **Compose box** — existing loopback textarea, generalised. Clears after a
  successful Send so the previous message cannot be silently re-sent.
- **Send** — runs the node.

The connected text input remains a fallback: when the compose box is empty, the
connected value is used. Existing wired workflows therefore keep working with no
edit. When both are present the compose box wins, because it is the more recent,
more deliberate act.

---

## 3. New controls

Placed with the existing inline parameters.

| Control | Field | Enabled when |
|---|---|---|
| ☑ Generator friendly | `generatorFriendly?: boolean` | always |
| ☑ Generate negative prompt | `generateNegativePrompt?: boolean` | Generator friendly is on |
| Max characters | `maxPromptChars?: number \| null` | Generator friendly is on |

Negative prompts are a generator artifact and are meaningless for a plain
conversational reply, hence the gating. Max characters applies to the positive
generator-friendly prompt only; empty / 0 / absent means no limit.

---

## 4. Deriving the prompt — one call, tagged blocks

When **Generator friendly** is on, an internal instruction is appended to the
system prompt asking for the conversational reply followed by:

```
<prompt>…</prompt>
```

and, when **Generate negative prompt** is also on, additionally:

```
<negative_prompt>…</negative_prompt>
```

Both blocks come back in the same reply, so the negative prompt costs no extra
call. The instruction must state plainly that the prompt block contains only the
generator prompt — no preamble, no commentary, no markdown.

### Parsed fields

```ts
/** Generator-ready prompt parsed from <prompt>. Null when the checkbox is off. */
derivedPrompt?: string | null;
/** Parsed from <negative_prompt>. Null when that checkbox is off. */
derivedNegativePrompt?: string | null;
/** Set when a reply had to be used unstripped, or a shrink loop gave up. Shown
 *  as a badge on the node and cleared at the start of each Send. */
derivedWarning?: string | null;
```

### Missing-block handling

This protocol's known failure — the same shape loopback used — is the model
omitting the block. Accepted deliberately in exchange for staying at one call.

1. `<prompt>` present → use it.
2. Absent → **one** retry: the failed reply is appended as an assistant turn and
   a new user message asks for the block alone — "Return only the
   `<prompt>…</prompt>` block for that answer. No other text." This is cheaper
   and more targeted than re-running the original request, and it gives the model
   its own answer to work from rather than asking it to redo the thinking.
   The retry exchange is **not** written to the transcript; it is plumbing.
3. Still absent → use the entire reply as `derivedPrompt`, and set
   `derivedWarning` to "prompt not stripped".

`<negative_prompt>` is covered by the same retry. If it is still missing after
it, leave `derivedNegativePrompt` null, leave any existing negative prompt node
**untouched**, and add to the warning. A missing negative must never blank a node
the user has already wired.

The transcript always stores the full raw reply, including the tags. Stripping is
a display and export concern, not a history one — the history must stay faithful
to what the model actually said.

---

## 5. Max characters

Runs after parsing, on `derivedPrompt`, only when `maxPromptChars` is set and the
prompt exceeds it.

```
attempts = [derivedPrompt]
while over the limit and reduction calls < 3:
    ask the model to shorten the CURRENT text to under N characters,
    preserving meaning, returning only the prompt
    append the result to attempts
use the shortest attempt
if the shortest is still over: derivedWarning = "<n> characters over limit"
```

We count characters ourselves and never ask the model to count — models are
unreliable at it, and the count is free for us. The reduction prompt states the
target number and the current count.

Cap is **3** reduction calls. The shortest attempt is used rather than the last,
because a reduction pass can come back longer than its input. The result is never
truncated: an over-length but coherent prompt is more useful than one severed
mid-phrase, and the warning makes the overage visible.

Negative prompts are not length-limited in this iteration.

---

## 6. Prompt nodes

Two buttons under the compose box:

- **Send to prompt node** — creates a new `prompt` node via `addNode("prompt", pos,
  { prompt: text })` and stores its id. Position: to the **right** of the LLM
  node, offset by the LLM node's width + 40px, vertically aligned with its top.
  With negatives on, the negative node goes directly below the positive one,
  offset by the positive node's height + 20px. Repeated Sends offset each new
  pair a further 30px down so they fan out instead of stacking exactly.
- **Update prompt node** — overwrites the stored node's `prompt` field. Does not
  move it: once you have placed a node, it stays where you put it.

```ts
/** Id of the prompt node this LLM node last created or updated. */
promptNodeId?: string | null;
/** Same, for the negative prompt node. Tracked separately. */
negativePromptNodeId?: string | null;
```

**Update is disabled** when the id is absent, or the node no longer exists, or is
no longer of type `prompt` — with a tooltip saying why. It never creates. This
preserves the explicit rule that nothing appears on the canvas unless Send is
pressed.

When **Generate negative prompt** is on, both buttons act on both nodes: Send
creates two (positive and negative), Update writes both. The two ids are tracked
separately so deleting one does not disable the other.

### Content written

| Generator friendly | positive node gets | negative node gets |
|---|---|---|
| on | `derivedPrompt` | `derivedNegativePrompt` |
| off | the raw assistant reply | n/a (checkbox unavailable) |

Neither node is auto-connected to anything. A prompt node is a source; there is
no correct edge to guess.

---

## 7. Cost

| situation | calls |
|---|---|
| Send, everything off | 1 |
| Generator friendly on | 1 |
| + negative prompt | 1 (second block, same reply) |
| tag missing | +1 (retry) |
| over character limit | +1 to +3 |

Worst case for a single Send is 5. The common case stays at 1, which is the
reason the tagged-block protocol was chosen over a second derivation call.

---

## 8. Testing

`vitest`. The LLM call is mocked, as in the existing executor tests.

**Migration** — the highest-value tests, because these touch files already on
disk. All three old shapes map correctly; migration is idempotent; a loopback
node keeps its `conversation` array.

**Parsing** — both blocks present; positive only; neither; malformed or unclosed
tags; tags containing newlines and angle brackets; text before and after the
blocks. Parsing must never throw — a bad reply degrades to the fallback.

**Retry** — one retry on a missing block and no more; falls back to the full reply
with the warning set; a successful retry leaves no warning.

**Shrink loop** — converges and stops as soon as it is under; stops at 3 calls;
uses the shortest attempt rather than the last, including when a pass returns
something longer; sets the warning with the correct overage; is skipped entirely
when `maxPromptChars` is unset or the prompt already fits.

**Buttons** — Send creates a node and records its id; Update writes to that node;
Update is disabled when the id is missing, dangling, or points at a non-prompt
node; with negatives on both nodes are handled and tracked independently; a
missing `<negative_prompt>` leaves an existing negative node untouched.

**Send semantics** — `rememberTurns: false` transmits exactly one message;
`true` transmits the transcript, honouring `maxHistoryTurns`.

---

## Implementation order

Three stages, each independently shippable and independently verifiable. The
first is the risky one because it touches saved files; do it alone and confirm a
real workflow still opens before starting the second.

1. **Mode collapse + removal** — `rememberTurns`, the migration, the edge
   cleanup, and deleting the loopback surface. Verify by opening several saved
   workflows and confirming their LLM nodes keep their transcripts and settings.
2. **Inline chat** — compose box and Send on every node, connected-input
   fallback. Verify a wired workflow still runs untouched.
3. **Generator-friendly, negative prompt, max characters, prompt-node buttons** —
   the new derivation and canvas output.

## Decisions worth recording

**Tagged blocks over a second call.** A second derivation call would be more
reliable — the model does one job per call. The tagged block was chosen anyway,
for cost and latency, with the retry and fallback as the mitigation. This is the
same protocol shape that loopback used and that did not work as intended; if the
warning badge starts appearing often in practice, revisit this first.

**Nothing is created automatically.** Both prompt-node actions are explicit
button presses. Automatic creation would fill the canvas during a long chat.

**The transcript keeps the raw reply.** History stays faithful to the model's
actual output; stripping applies only to what leaves the node.
