# LLM Node: Inline Chat, Generator Prompts, Prompt Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the LLM node's three modes to one inline chat node, and let it derive a generator-ready prompt (plus negative prompt, plus a character budget) and put it on the canvas as prompt nodes.

**Architecture:** `conversationMode`/`loopbackMode` become one `rememberTurns` boolean, migrated on load. Loopback's inline compose box becomes standard. The generator prompt is parsed from `<prompt>`/`<negative_prompt>` blocks in the same reply — reusing and generalising the existing `parseLoopbackReply` — with one stricter retry and a fallback badge. A local character count drives a bounded shrink loop.

**Tech Stack:** TypeScript, Next.js 16, Zustand, React Flow, vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-21-llm-node-chat-and-prompt-nodes-design.md`

## Global Constraints

- Work directly on `develop`. No feature branches, no PRs.
- One logical task = one commit. Do not batch.
- `npx tsc --noEmit` and `npx vitest run` must both pass before every commit.
- Baseline before starting: 2163 tests, 105 files, all green.
- Migration must be **idempotent** — workflows are loaded, saved and reloaded repeatedly.
- Never blank a prompt node the user has wired. Absent data leaves a node untouched.
- The transcript always stores the **raw** reply including tags. Stripping is an export concern.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types/nodes.ts` | `LLMGenerateNodeData` fields | modify |
| `src/store/utils/llmNodeMigration.ts` | mode migration + dead-edge cleanup | **create** |
| `src/store/workflowStore.ts` | call migration in `loadWorkflow` (line ~2408) | modify |
| `src/store/execution/taggedReply.ts` | `<prompt>` / `<negative_prompt>` parser | **create** (from `parseLoopbackReply`) |
| `src/store/execution/llmGenerateExecutor.ts` | drop loopback, add derivation + shrink loop | modify |
| `src/store/execution/loopbackSkill.ts` | — | **delete** |
| `src/components/nodes/LLMGenerateNode.tsx` | inline chat for all, new controls, buttons | modify |
| `src/components/nodes/ControlPanel.tsx` | drop loopback mode selector | modify |
| `src/components/nodes/DynamicInputHandles.tsx` | drop feedback input | modify |
| `src/components/nodes/FloatingNodeHeader.tsx` | drop loopback label | modify |
| `src/components/WorkflowCanvas.tsx` | drop loopback wiring | modify |

---

## STAGE 1 — Mode collapse and removal

Touches files already on disk. Ship and verify alone.

### Task 1: `rememberTurns` field and migration

**Files:**
- Modify: `src/types/nodes.ts` (`LLMGenerateNodeData`)
- Create: `src/store/utils/llmNodeMigration.ts`
- Create: `src/store/utils/__tests__/llmNodeMigration.test.ts`

**Interfaces:**
- Produces: `migrateLlmNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { migrateLlmNodes } from "../llmNodeMigration";
import type { WorkflowNode, WorkflowEdge } from "@/types";

const llm = (data: Record<string, unknown>): WorkflowNode =>
  ({ id: "llm-1", type: "llmGenerate", position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
const dataOf = (n: WorkflowNode) => n.data as Record<string, unknown>;

describe("migrateLlmNodes", () => {
  it("maps one-shot to rememberTurns false", () => {
    const { nodes } = migrateLlmNodes([llm({ conversationMode: false })], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(false);
  });

  it("maps an absent conversationMode to rememberTurns false", () => {
    const { nodes } = migrateLlmNodes([llm({})], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(false);
  });

  it("maps conversation mode to rememberTurns true", () => {
    const { nodes } = migrateLlmNodes([llm({ conversationMode: true })], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(true);
  });

  it("maps loopback to rememberTurns true and keeps the transcript", () => {
    const conversation = [{ role: "user", content: "hi" }];
    const { nodes } = migrateLlmNodes([llm({ loopbackMode: true, conversation })], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(true);
    expect(dataOf(nodes[0]).conversation).toEqual(conversation);
  });

  it("drops the loopback-only fields", () => {
    const { nodes } = migrateLlmNodes(
      [llm({ loopbackMode: true, outputPrompt: "x", lastLoopbackInput: "y" })], []);
    const d = dataOf(nodes[0]);
    expect(d.loopbackMode).toBeUndefined();
    expect(d.conversationMode).toBeUndefined();
    expect(d.outputPrompt).toBeUndefined();
    expect(d.lastLoopbackInput).toBeUndefined();
  });

  it("keeps composeInput, which every node now uses", () => {
    const { nodes } = migrateLlmNodes([llm({ loopbackMode: true, composeInput: "draft" })], []);
    expect(dataOf(nodes[0]).composeInput).toBe("draft");
  });

  it("is idempotent", () => {
    const once = migrateLlmNodes([llm({ conversationMode: true })], []);
    const twice = migrateLlmNodes(once.nodes, once.edges);
    expect(twice.nodes[0].data).toEqual(once.nodes[0].data);
  });

  it("drops edges into the removed feedback input", () => {
    const edges = [{ id: "e1", source: "a", target: "llm-1", targetHandle: "image-feedback" }] as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ loopbackMode: true })], edges);
    expect(out.edges).toEqual([]);
  });

  it("drops edges out of the removed prompt output", () => {
    const edges = [{ id: "e1", source: "llm-1", sourceHandle: "prompt", target: "b" }] as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ loopbackMode: true })], edges);
    expect(out.edges).toEqual([]);
  });

  it("keeps the normal text output edge", () => {
    const edges = [{ id: "e1", source: "llm-1", sourceHandle: "text", target: "b" }] as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ conversationMode: true })], edges);
    expect(out.edges).toHaveLength(1);
  });

  it("leaves non-LLM nodes and their edges alone", () => {
    const other = { id: "p-1", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "x" } } as unknown as WorkflowNode;
    const edges = [{ id: "e1", source: "p-1", sourceHandle: "text", target: "b" }] as WorkflowEdge[];
    const out = migrateLlmNodes([other], edges);
    expect(out.nodes[0]).toBe(other);
    expect(out.edges).toHaveLength(1);
  });

  it("returns the same array reference when nothing changes", () => {
    const nodes = [llm({ rememberTurns: true })];
    const out = migrateLlmNodes(nodes, []);
    expect(out.nodes).toBe(nodes);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/utils/__tests__/llmNodeMigration.test.ts`
Expected: FAIL — cannot resolve `../llmNodeMigration`.

- [ ] **Step 3: Add the field to types**

In `src/types/nodes.ts`, inside `LLMGenerateNodeData`, replace the `conversationMode` and `loopbackMode` declarations (and the loopback-only fields `outputPrompt`, `lastLoopbackInput`, and the pinned first-prompt anchor) with:

```ts
  /** Send the whole transcript on each Send. False = only the newest message
   *  is transmitted; the transcript is still kept and shown, just not sent.
   *  Replaces the old conversationMode / loopbackMode pair. */
  rememberTurns?: boolean;
  /** The in-node compose box. Cleared after each successful Send so the
   *  previous message cannot be silently re-sent. Falls back to the connected
   *  text input when empty. */
  composeInput?: string;
```

- [ ] **Step 4: Write the migration**

Create `src/store/utils/llmNodeMigration.ts`:

```ts
import type { WorkflowNode, WorkflowEdge } from "@/types";

/** Fields that existed only to serve loopback and have no meaning now. */
const DEAD_FIELDS = [
  "conversationMode", "loopbackMode", "outputPrompt",
  "lastLoopbackInput", "firstImagePrompt",
] as const;

/** Handles removed with loopback. An edge left pointing at a handle that no
 *  longer renders is invisible yet still resolves into request bodies, and
 *  conformEdgesToRenderablePins covers NEITHER of these: it only inspects
 *  target handles, and its own rules exempt image-feedback. So we drop them. */
const DEAD_TARGET_HANDLE = "image-feedback";
const DEAD_SOURCE_HANDLE = "prompt";

/**
 * Collapse the old three-mode LLM node onto `rememberTurns`, and remove edges
 * attached to the handles that went with loopback.
 *
 * Idempotent: an already-migrated node has no dead fields, so it is returned
 * untouched. Array identity is preserved when nothing changes, so callers can
 * skip a state update.
 */
export function migrateLlmNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const llmIds = new Set<string>();
  let nodesChanged = false;

  const outNodes = nodes.map((n) => {
    if (n.type !== "llmGenerate") return n;
    llmIds.add(n.id);
    const d = n.data as Record<string, unknown>;
    const hasDead = DEAD_FIELDS.some((k) => k in d);
    if (!hasDead && "rememberTurns" in d) return n;

    const next: Record<string, unknown> = { ...d };
    // loopback implied conversation, so either flag means "remember".
    const remember = d.loopbackMode === true || d.conversationMode === true;
    for (const k of DEAD_FIELDS) delete next[k];
    next.rememberTurns = "rememberTurns" in d ? d.rememberTurns : remember;
    nodesChanged = true;
    return { ...n, data: next } as WorkflowNode;
  });

  const outEdges = edges.filter((e) => {
    if (e.target && llmIds.has(e.target) && e.targetHandle === DEAD_TARGET_HANDLE) return false;
    if (e.source && llmIds.has(e.source) && e.sourceHandle === DEAD_SOURCE_HANDLE) return false;
    return true;
  });

  return {
    nodes: nodesChanged ? outNodes : nodes,
    edges: outEdges.length === edges.length ? edges : outEdges,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/store/utils/__tests__/llmNodeMigration.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Wire it into loadWorkflow**

In `src/store/workflowStore.ts`, import it beside the pin migration (line ~67) and call it in `loadWorkflow` (line ~2408) **before** nodes are set into state, passing both nodes and edges through.

- [ ] **Step 7: Verify the suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all green; total 2175.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: collapse LLM node modes onto rememberTurns"
```

### Task 2: Remove the loopback surface

**Files:**
- Delete: `src/store/execution/loopbackSkill.ts`
- Modify: `src/store/execution/llmGenerateExecutor.ts` (drop `loopbackMode` branches at lines ~63, 74, 206, 220, 240)
- Modify: `src/components/nodes/LLMGenerateNode.tsx`, `ControlPanel.tsx`, `DynamicInputHandles.tsx`, `FloatingNodeHeader.tsx`, `WorkflowCanvas.tsx`
- Modify: `src/app/api/llm/route.ts` (stale loopback comment at line ~383 only — no branch exists)
- Move: `src/store/execution/__tests__/loopbackParse.test.ts` → covered by Task 4; delete once Task 4's tests exist

**Interfaces:**
- Consumes: `rememberTurns` from Task 1.
- Produces: an LLM node with one `text` output and no feedback input.

- [ ] **Step 1: Remove the mode selector** — in `ControlPanel.tsx` and `LLMGenerateNode.tsx`, replace the 3-way `chatMode` derivation and `handleSetMode` with a single "Remember previous turns" checkbox bound to `rememberTurns`.

- [ ] **Step 2: Remove the handles** — in `DynamicInputHandles.tsx` drop the `image-feedback` input; remove the second `prompt` output from the node's handle list.

- [ ] **Step 3: Remove executor branches** — in `llmGenerateExecutor.ts` delete every `loopbackMode` branch; replace `const useConversation = nodeData.conversationMode === true` with `nodeData.rememberTurns === true`. Keep `parseLoopbackReply` for now; Task 4 moves it.

- [ ] **Step 4: Delete the skill** — `git rm src/store/execution/loopbackSkill.ts` and remove its imports.

- [ ] **Step 5: Verify nothing references loopback**

Run: `grep -rn "loopback\|loopbackMode" src/ --include=*.ts --include=*.tsx`
Expected: only `parseLoopbackReply` in the executor and its test (both handled in Task 4).

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 7: Manual check** — open a real saved workflow (e.g. `01_30_001`) in the browser and confirm its 3 LLM nodes keep their transcripts and settings, and the canvas has no ghost edges.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: remove loopback mode from the LLM node"
```

---

## STAGE 2 — Inline chat

### Task 3: Compose box and Send on every node

**Files:**
- Modify: `src/components/nodes/LLMGenerateNode.tsx`

**Interfaces:**
- Consumes: `composeInput`, `rememberTurns` from Task 1.

- [ ] **Step 1: Unconditional body** — remove the `conversationMode ? … : …` branch around the node body. Always render `ConversationTranscript`, then the compose textarea, then Send. Delete the loopback-only emerald prompt panel and its warning strip.

- [ ] **Step 2: Keep the connected-input fallback** — in the executor, the message sent is `composeInput` when non-empty, else the connected text input. Compose wins because it is the more recent deliberate act.

- [ ] **Step 3: Clear on success** — after a successful Send, set `composeInput: ""`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 5: Manual check** — type in the box, Send, confirm the reply appears inline and the box clears. Then confirm a workflow wired through the text input still runs with the box empty.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: every LLM node is an inline chat node"
```

---

## STAGE 3 — Generator prompts and prompt nodes

### Task 4: The tagged-reply parser

**Files:**
- Create: `src/store/execution/taggedReply.ts` (generalised from `parseLoopbackReply`)
- Create: `src/store/execution/__tests__/taggedReply.test.ts`
- Delete: `src/store/execution/__tests__/loopbackParse.test.ts`

**Interfaces:**
- Produces: `parseTaggedReply(raw: string): { reply: string; prompt: string | null; negativePrompt: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseTaggedReply } from "../taggedReply";

describe("parseTaggedReply", () => {
  it("extracts both blocks", () => {
    const r = parseTaggedReply("Sure.\n<prompt>a warehouse</prompt>\n<negative_prompt>blurry</negative_prompt>");
    expect(r.prompt).toBe("a warehouse");
    expect(r.negativePrompt).toBe("blurry");
  });

  it("extracts the positive when the negative is absent", () => {
    const r = parseTaggedReply("Sure.\n<prompt>a warehouse</prompt>");
    expect(r.prompt).toBe("a warehouse");
    expect(r.negativePrompt).toBeNull();
  });

  it("returns nulls when no block is present", () => {
    const r = parseTaggedReply("I think the set should feel industrial.");
    expect(r.prompt).toBeNull();
    expect(r.negativePrompt).toBeNull();
  });

  it("keeps the RAW reply, tags included — history stays faithful", () => {
    const raw = "Sure.\n<prompt>a warehouse</prompt>";
    expect(parseTaggedReply(raw).reply).toBe(raw);
  });

  it("handles multi-line and angle-bracketed content", () => {
    const r = parseTaggedReply("<prompt>line one,\nline two <lens> 35mm</prompt>");
    expect(r.prompt).toBe("line one,\nline two <lens> 35mm");
  });

  it("ignores an unclosed tag rather than throwing", () => {
    const r = parseTaggedReply("<prompt>never closed");
    expect(r.prompt).toBeNull();
  });

  it("takes the LAST block when the model emits several", () => {
    const r = parseTaggedReply("<prompt>first</prompt> then <prompt>second</prompt>");
    expect(r.prompt).toBe("second");
  });

  it("trims surrounding whitespace inside a block", () => {
    expect(parseTaggedReply("<prompt>\n  spaced  \n</prompt>").prompt).toBe("spaced");
  });

  it("treats an empty block as absent", () => {
    expect(parseTaggedReply("<prompt>   </prompt>").prompt).toBeNull();
  });

  it("never throws on any input", () => {
    for (const s of ["", "<prompt>", "</prompt>", "<<>>", " "]) {
      expect(() => parseTaggedReply(s)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/store/execution/__tests__/taggedReply.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * Pull the generator-ready blocks out of a reply.
 *
 * Generalised from parseLoopbackReply, which read a single <image_prompt>.
 * The LAST block wins: when a model restates itself the final answer is the
 * one it settled on.
 *
 * `reply` is the RAW text, tags and all — the transcript must stay faithful to
 * what the model actually said; stripping is an export concern.
 */
function lastBlock(raw: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let out: string | null = null;
  for (const m of raw.matchAll(re)) {
    const inner = m[1].trim();
    if (inner) out = inner;
  }
  return out;
}

export function parseTaggedReply(raw: string): {
  reply: string;
  prompt: string | null;
  negativePrompt: string | null;
} {
  const text = typeof raw === "string" ? raw : "";
  return {
    reply: text,
    prompt: lastBlock(text, "prompt"),
    negativePrompt: lastBlock(text, "negative_prompt"),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Delete the old test and parser** — remove `parseLoopbackReply` from `llmGenerateExecutor.ts` and delete `__tests__/loopbackParse.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: tagged-reply parser for generator prompts"
```

### Task 5: Generator-friendly derivation with retry

**Files:**
- Modify: `src/types/nodes.ts` — add `generatorFriendly?: boolean`, `generateNegativePrompt?: boolean`, `maxPromptChars?: number | null`, `derivedPrompt?: string | null`, `derivedNegativePrompt?: string | null`, `derivedWarning?: string | null`
- Modify: `src/store/execution/llmGenerateExecutor.ts`
- Modify: `src/components/nodes/LLMGenerateNode.tsx` — the two checkboxes, the Max characters field, the warning badge
- Create: `src/store/execution/__tests__/derivePrompt.test.ts`

**Interfaces:**
- Consumes: `parseTaggedReply` from Task 4.
- Produces: `derivePrompt(reply, opts, callModel): Promise<{ prompt, negativePrompt, warning }>` where `callModel: (messages) => Promise<string>`.

- [ ] **Step 1: Write the failing test** — cover: block present, no extra call; block absent triggers exactly ONE retry; retry succeeding leaves `warning` null; retry failing sets `warning` to "prompt not stripped" and returns the whole reply as `prompt`; a missing `<negative_prompt>` after retry leaves `negativePrompt` null with the warning noting it.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement** — append the tag instruction to the system prompt when `generatorFriendly` is on (naming `<prompt>`, and `<negative_prompt>` when enabled; state plainly: only the generator prompt inside, no preamble, no markdown). Parse. On a missing positive block, issue one retry that appends the failed reply as an assistant turn and asks for the block alone; do **not** write the retry exchange to the transcript.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Verify** — `npx tsc --noEmit && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: generator-friendly and negative prompts on the LLM node"
```

### Task 6: Max-characters shrink loop

**Files:**
- Modify: `src/store/execution/llmGenerateExecutor.ts`
- Create: `src/store/execution/__tests__/shrinkPrompt.test.ts`

**Interfaces:**
- Produces: `shrinkToLimit(text: string, limit: number, callModel: (t: string, limit: number) => Promise<string>): Promise<{ text: string; warning: string | null }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { shrinkToLimit } from "../shrinkPrompt";

describe("shrinkToLimit", () => {
  it("does nothing when already under the limit", async () => {
    const call = vi.fn();
    const r = await shrinkToLimit("short", 100, call);
    expect(call).not.toHaveBeenCalled();
    expect(r.text).toBe("short");
    expect(r.warning).toBeNull();
  });

  it("stops as soon as it fits", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    const r = await shrinkToLimit("wayyy too long", 5, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.text).toBe("ok");
    expect(r.warning).toBeNull();
  });

  it("gives up after 3 calls and warns with the overage", async () => {
    const call = vi.fn().mockResolvedValue("still far too long");
    const r = await shrinkToLimit("original overlong text", 5, call);
    expect(call).toHaveBeenCalledTimes(3);
    expect(r.warning).toMatch(/13 characters over limit/);
  });

  it("keeps the SHORTEST attempt, not the last", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce("bbbbbbbb")   // 8
      .mockResolvedValueOnce("cc")          // 2  <- shortest
      .mockResolvedValueOnce("dddddddddd"); // 10
    const r = await shrinkToLimit("aaaaaaaaaaaa", 1, call);
    expect(r.text).toBe("cc");
  });

  it("never truncates", async () => {
    const call = vi.fn().mockResolvedValue("abcdefghij");
    const r = await shrinkToLimit("abcdefghijkl", 3, call);
    expect(r.text).toBe("abcdefghij");
  });

  it("treats a limit of 0 or null as no limit", async () => {
    const call = vi.fn();
    expect((await shrinkToLimit("anything", 0, call)).text).toBe("anything");
    expect(call).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement** — loop while over limit and calls < 3, collecting attempts; return the shortest; warn with `shortest.length - limit` when still over. Count locally; the model is only ever asked to shorten, never to count.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: bounded shrink loop for the generator prompt"
```

### Task 7: Prompt-node buttons

**Files:**
- Modify: `src/types/nodes.ts` — add `promptNodeId?: string | null`, `negativePromptNodeId?: string | null`
- Modify: `src/components/nodes/LLMGenerateNode.tsx`
- Create: `src/components/__tests__/LLMPromptNodeButtons.test.tsx`

**Interfaces:**
- Consumes: `addNode(type, position, initialData)` and `updateNodeData(id, data)` from the store; `derivedPrompt` / `derivedNegativePrompt` from Task 5.

- [ ] **Step 1: Write the failing test** — Send creates a `prompt` node carrying the text and records its id; Update writes to that node; Update is disabled when the id is absent, when the node is gone, and when the id points at a non-`prompt` node; with negatives on both nodes are created and tracked independently; a null `derivedNegativePrompt` leaves an existing negative node untouched.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement** — Send: `addNode("prompt", pos, { prompt: text })`, position right of the LLM node by its width + 40px, negative below the positive by its height + 20px, each repeated Send offset a further 30px down. Update: `updateNodeData(storedId, { prompt: text })`, never moves the node, never creates.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Verify** — `npx tsc --noEmit && npx vitest run`

- [ ] **Step 6: Manual check** — Send, confirm two nodes appear correctly placed; wire the positive into a generator; Send again and confirm the wire survives and the text updates.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: put LLM replies on the canvas as prompt nodes"
```

---

## Self-Review

**Spec coverage.** §1 mode model → Task 1. §1 removal surface → Task 2. §2 node body → Task 3. §3 new controls → Task 5 (UI). §4 protocol and parsing → Tasks 4–5. §5 max characters → Task 6. §6 prompt nodes → Task 7. §7 cost → no code. §8 testing → distributed across the tasks. No gaps.

**Deviation from the spec, deliberate.** The spec said to delete `loopbackParse.test.ts` and `parseLoopbackReply` outright. Reading the code showed `parseLoopbackReply` is already a tagged-block parser — the exact mechanism the new protocol needs. Task 4 generalises it to `parseTaggedReply` instead of deleting and rewriting. The spec's claim that `/api/llm/route.ts` holds a loopback branch was also wrong: it holds only a stale comment.

**Type consistency.** `rememberTurns`, `composeInput`, `generatorFriendly`, `generateNegativePrompt`, `maxPromptChars`, `derivedPrompt`, `derivedNegativePrompt`, `derivedWarning`, `promptNodeId`, `negativePromptNodeId` are used with identical names and types in every task that touches them. `parseTaggedReply` returns `{ reply, prompt, negativePrompt }` in Task 4 and is consumed under those names in Task 5.
