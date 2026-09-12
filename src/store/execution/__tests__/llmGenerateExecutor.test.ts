import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeLlmGenerate, dedupeImagesAcrossTurns } from "../llmGenerateExecutor";
import { clearConversationPatch } from "@/store/utils/clearConversation";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const defaultProviderSettings = {
  providers: {
    gemini: { apiKey: "gkey" },
    replicate: { apiKey: "" },
    fal: { apiKey: "" },
    kie: { apiKey: "" },
    wavespeed: { apiKey: "" },
    openai: { apiKey: "okey" },
    anthropic: { apiKey: "" },
  },
} as any;

function makeNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "llm-1",
    type: "llmGenerate",
    position: { x: 0, y: 0 },
    data: {
      outputText: null,
      inputImages: [],
      inputPrompt: null,
      status: null,
      error: null,
      provider: "google",
      model: "gemini-2.5-flash",
      temperature: 0.7,
      maxTokens: 1024,
      ...data,
    },
  } as WorkflowNode;
}

function makeCtx(
  node: WorkflowNode,
  overrides: Partial<NodeExecutionContext> = {}
): NodeExecutionContext {
  return {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      text: "test llm prompt",
      dynamicInputs: {},
      easeCurve: null,
    }),
    updateNodeData: vi.fn(),
    getFreshNode: vi.fn().mockReturnValue(node),
    getEdges: vi.fn().mockReturnValue([]),
    getNodes: vi.fn().mockReturnValue([node]),
    providerSettings: defaultProviderSettings,
    addIncurredCost: vi.fn(),
    addToGlobalHistory: vi.fn(),
    generationsPath: null,
    saveDirectoryPath: null,
    trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeLlmGenerate", () => {
  it("should throw when no text input", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await expect(executeLlmGenerate(ctx)).rejects.toThrow("Missing text input");

    // The message now points at the compose box, which is how the node is driven.
    expect(ctx.updateNodeData).toHaveBeenCalledWith("llm-1", expect.objectContaining({
      status: "error",
      error: expect.stringContaining("type a message"),
    }));
  });

  it("should set loading status before API call", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "generated text" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "loading"
    );
    expect(loadingCall).toBeDefined();
  });

  it("should call /api/llm with correct payload", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result text" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/llm",
      expect.objectContaining({
        method: "POST",
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Prompt is sent as a single user turn in the messages array
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].text).toBe("test llm prompt");
    expect(body.provider).toBe("google");
    expect(body.model).toBe("gemini-2.5-flash");
    // Parameters travel as a bag now, not as top-level fields: which ones a
    // model accepts is decided by its schema, and the route filters the bag
    // against it. The node no longer decides the shape of the request.
    expect(body.parameters).toEqual(node.data.parameters);
  });

  it("should include images in request when connected", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,img1"],
        videos: [],
        audio: [],
        text: "describe this",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "description" }),
    });

    await executeLlmGenerate(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].images).toEqual(["data:image/png;base64,img1"]);
  });

  it("should not include images field when none connected", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].images).toBeUndefined();
  });

  it("should update node with result text on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "generated output" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    // composeInput is cleared on success so the same message is not re-sent.
    expect(ctx.updateNodeData).toHaveBeenCalledWith("llm-1", {
      outputText: "generated output",
      composeInput: "",
      status: "complete",
      error: null,
    });
  });

  it("should throw on HTTP error", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"error": "LLM down"}'),
    });

    const ctx = makeCtx(node);
    await expect(executeLlmGenerate(ctx)).rejects.toThrow("LLM down");
  });

  it("should throw on API failure", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, error: "Token limit exceeded" }),
    });

    const ctx = makeCtx(node);
    await expect(executeLlmGenerate(ctx)).rejects.toThrow("Token limit exceeded");
  });

  it("should use stored fallback in regenerate mode", async () => {
    // Stored images must look like real image URLs — the executor drops
    // values that don't (defensive filter against mis-wired text sources).
    const node = makeNode({
      inputImages: ["data:image/png;base64,stored"],
      inputPrompt: "stored llm prompt",
    });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result" }),
    });

    await executeLlmGenerate(ctx, { useStoredFallback: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].text).toBe("stored llm prompt");
    expect(body.messages[0].images).toEqual(["data:image/png;base64,stored"]);
  });
});

describe("clearConversationPatch (Clear history)", () => {
  /** The state a node is in after a few exchanges. */
  function makeUsedNode(patch: Record<string, unknown>): WorkflowNode {
    return makeNode({
      conversation: [
        { role: "user", text: "same open channel below villa-covered hillside", timestamp: 1 },
        { role: "assistant", text: "old answer", timestamp: 2 },
      ],
      outputText: "old answer",
      inputPrompt: "same open channel below villa-covered hillside",
      inputImages: ["data:image/png;base64,stored"],
      ...patch,
    });
  }

  /** Send with an empty compose box and nothing wired — the reported repro. */
  function sendWithNothingWired(node: WorkflowNode) {
    return makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
  }

  it("re-sent the previous message when only the transcript was cleared", async () => {
    // Mutation check: the OLD patch. If this ever stops re-sending, the
    // executor's stored fallback changed and the fix below is moot.
    const node = makeUsedNode({ conversation: [], outputText: null });
    const ctx = sendWithNothingWired(node);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result" }),
    });

    await executeLlmGenerate(ctx, { useStoredFallback: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].text).toBe("same open channel below villa-covered hillside");
    expect(body.messages[0].images).toEqual(["data:image/png;base64,stored"]);
  });

  it("sends nothing after a full clear, on the Send path that uses stored fallbacks", async () => {
    const node = makeUsedNode(clearConversationPatch());
    const ctx = sendWithNothingWired(node);

    await expect(
      executeLlmGenerate(ctx, { useStoredFallback: true })
    ).rejects.toThrow("Missing text input");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("covers every field the executor falls back to", () => {
    // The executor reads `nodeData.inputPrompt` and `nodeData.inputImages`
    // when the compose box is empty. A fallback field the patch does not
    // clear is a message that survives "Clear history".
    const patch = clearConversationPatch();
    // Presence matters as much as the value: `updateNodeData` merges, so a
    // key the patch omits keeps its old value rather than being cleared.
    for (const field of ["conversation", "outputText", "inputPrompt", "inputImages"]) {
      expect(Object.prototype.hasOwnProperty.call(patch, field)).toBe(true);
    }
    expect(patch.inputPrompt).toBeNull();
    expect(patch.inputImages).toEqual([]);
    expect(patch.conversation).toEqual([]);
    expect(patch.outputText).toBeNull();
  });
});


describe("an image already in the conversation is not re-sent", () => {
  const IMG_A = "data:image/png;base64,AAAA";
  const IMG_B = "data:image/png;base64,BBBB";

  function convoNode(patch: Record<string, unknown> = {}) {
    return makeNode({
      rememberTurns: true,
      conversation: [
        { role: "user", text: "what is this?", images: [IMG_A], timestamp: 1 },
        { role: "assistant", text: "a cat", timestamp: 2 },
      ],
      ...patch,
    });
  }

  /** The pin is still connected, so the same image arrives again. */
  function stillConnected(node: WorkflowNode) {
    return makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [IMG_A],
        videos: [], audio: [], text: "and now?",
        dynamicInputs: {}, easeCurve: null,
      }),
    });
  }

  function sentBody() {
    return JSON.parse(mockFetch.mock.calls[0][1].body);
  }

  it("omits it from the new turn when the history already carries it", async () => {
    const ctx = stillConnected(convoNode());
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, text: "ok" }) });

    await executeLlmGenerate(ctx);

    const msgs = sentBody().messages;
    // History still carries the image exactly once...
    expect(msgs[0].images).toEqual([IMG_A]);
    // ...and the new turn does not repeat it.
    expect(msgs[msgs.length - 1].text).toBe("and now?");
    expect(msgs[msgs.length - 1].images).toBeUndefined();
  });

  it("sends a NEW image even while an old one is already there", async () => {
    const node = convoNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [IMG_A, IMG_B],
        videos: [], audio: [], text: "compare",
        dynamicInputs: {}, easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, text: "ok" }) });

    await executeLlmGenerate(ctx);

    const msgs = sentBody().messages;
    expect(msgs[msgs.length - 1].images).toEqual([IMG_B]);
  });

  it("re-sends once the history cap has trimmed the turn that carried it", async () => {
    // maxHistoryTurns=1 keeps the last 2 entries. Pad the transcript so the
    // turn holding IMG_A falls outside the window: the model can no longer see
    // it, so dropping it would be losing it.
    const node = makeNode({
      rememberTurns: true,
      maxHistoryTurns: 1,
      conversation: [
        { role: "user", text: "what is this?", images: [IMG_A], timestamp: 1 },
        { role: "assistant", text: "a cat", timestamp: 2 },
        { role: "user", text: "and?", timestamp: 3 },
        { role: "assistant", text: "still a cat", timestamp: 4 },
      ],
    });
    const ctx = stillConnected(node);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, text: "ok" }) });

    await executeLlmGenerate(ctx);

    const msgs = sentBody().messages;
    expect(msgs.some((m: { images?: string[] }) => m.images?.includes(IMG_A))).toBe(true);
    expect(msgs[msgs.length - 1].images).toEqual([IMG_A]);
  });

  it("still RECORDS the image on the new turn even when it is not re-sent", async () => {
    // The wire is thinned; the transcript is not. A turn that kept no copy of
    // its own image was fragile: deleting the one turn that held it erased the
    // picture from every later request and from the save.
    const ctx = stillConnected(convoNode());
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, text: "ok" }) });

    await executeLlmGenerate(ctx);

    const calls = vi.mocked(ctx.updateNodeData).mock.calls;
    const persisted = calls
      .map((c) => c[1] as { conversation?: Array<{ role: string; images?: string[] }> })
      .filter((patch) => !!patch.conversation)
      .pop();
    const userTurns = persisted!.conversation!.filter((t) => t.role === "user");
    expect(userTurns[userTurns.length - 1].images).toEqual([IMG_A]);
  });

  it("always sends in one-shot mode, where there is no history to rely on", async () => {
    const node = convoNode({ rememberTurns: false });
    const ctx = stillConnected(node);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, text: "ok" }) });

    await executeLlmGenerate(ctx);

    const msgs = sentBody().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].images).toEqual([IMG_A]);
  });
});

describe("dedupeImagesAcrossTurns", () => {
  const A = "data:image/png;base64,AAAA";
  const B = "data:image/png;base64,BBBB";

  it("keeps an image at its earliest turn and strips the repeats", () => {
    const out = dedupeImagesAcrossTurns([
      { role: "user", text: "1", images: [A], timestamp: 1 },
      { role: "assistant", text: "r", timestamp: 2 },
      { role: "user", text: "2", images: [A], timestamp: 3 },
    ]);
    expect(out[0].images).toEqual([A]);
    expect(out[2].images).toBeUndefined();
  });

  it("drops the key entirely rather than sending an empty array", () => {
    const out = dedupeImagesAcrossTurns([
      { role: "user", text: "1", images: [A], timestamp: 1 },
      { role: "user", text: "2", images: [A], timestamp: 2 },
    ]);
    expect("images" in out[1]).toBe(false);
  });

  it("keeps distinct images in the same turn", () => {
    const out = dedupeImagesAcrossTurns([
      { role: "user", text: "1", images: [A, B], timestamp: 1 },
    ]);
    expect(out[0].images).toEqual([A, B]);
  });

  it("counts only images actually in the payload, never bare refs", () => {
    // A turn holding only `imageRefs` failed to hydrate and goes out text-only.
    // Treating its ref as sent would suppress the later real copy — the one way
    // this can corrupt a conversation rather than just fail to save bandwidth.
    const out = dedupeImagesAcrossTurns([
      { role: "user", text: "1", imageRefs: ["img-deadbeef"], timestamp: 1 },
      { role: "user", text: "2", images: [A], timestamp: 2 },
    ]);
    expect(out[1].images).toEqual([A]);
  });

  it("survives the earliest carrier being deleted", () => {
    // The transcript keeps every turn's own copy, so removing turn 1 leaves
    // turn 2 holding the picture and it simply becomes the new carrier. This is
    // what the earlier design got wrong: it stored the image on ONE turn, and
    // deleting that turn erased it from the conversation for good.
    const full = [
      { role: "user" as const, text: "1", images: [A], timestamp: 1 },
      { role: "user" as const, text: "2", images: [A], timestamp: 2 },
    ];
    const afterDelete = dedupeImagesAcrossTurns(full.slice(1));
    expect(afterDelete[0].images).toEqual([A]);
  });

  it("leaves an image-free conversation untouched", () => {
    const msgs = [{ role: "user" as const, text: "hi", timestamp: 1 }];
    expect(dedupeImagesAcrossTurns(msgs)).toEqual(msgs);
  });
});
