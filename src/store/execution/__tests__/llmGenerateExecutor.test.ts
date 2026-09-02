import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeLlmGenerate } from "../llmGenerateExecutor";
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
