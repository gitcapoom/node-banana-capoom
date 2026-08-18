import { describe, it, expect, vi } from "vitest";
import {
  executeAnnotation,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeGlbViewer,
  executeBlur,
  executeComp,
} from "../simpleNodeExecutors";

// executeBlur's GPU commit + run-hydration are environment-bound — stub them.
vi.mock("@/utils/colorChain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/colorChain")>();
  return { ...actual, commitBlurNode: vi.fn().mockResolvedValue("data:image/png;base64,BLURRED") };
});
vi.mock("@/store/execution/hydrateForRun", () => ({
  ensureFullResForNodes: vi.fn().mockResolvedValue(undefined),
}));
// The comp composite is GPU/canvas-bound; the assertions here are about WHETHER
// it runs, not what it produces.
vi.mock("@/utils/compComposite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/compComposite")>();
  return {
    ...actual,
    compositeCompForExecutor: vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,COMPED", outW: 10, outH: 10,
    }),
  };
});
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode, WorkflowEdge } from "@/types";

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
      text: null,
      dynamicInputs: {},
      easeCurve: null,
    }),
    updateNodeData: vi.fn(),
    getFreshNode: vi.fn().mockReturnValue(node),
    getEdges: vi.fn().mockReturnValue([]),
    getNodes: vi.fn().mockReturnValue([]),
    providerSettings: {} as any,
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

function makeNode(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

describe("executeAnnotation", () => {
  it("should set sourceImage from connected image", async () => {
    const node = makeNode("ann", "annotation", { outputImage: null });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,abc"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeAnnotation(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("ann", { sourceImage: "data:image/png;base64,abc", sourceImageRef: undefined });
  });

  it("should pass through image as output when no annotations exist", async () => {
    const node = makeNode("ann", "annotation", { outputImage: null });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,abc"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeAnnotation(ctx);

    // outputImageThumbKey is cleared alongside the new output so nothing can
    // claim the previous thumb matches these pixels (see commitProcessorOutput).
    expect(ctx.updateNodeData).toHaveBeenCalledWith("ann", { outputImage: "data:image/png;base64,abc", outputImageRef: undefined, outputImageThumbKey: null });
  });

  it("should not overwrite existing annotated outputImage", async () => {
    const node = makeNode("ann", "annotation", { outputImage: "existing-annotated-image", sourceImage: "old-source" });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,abc"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeAnnotation(ctx);

    // Should set sourceImage but NOT overwrite outputImage (it has real annotations)
    expect(ctx.updateNodeData).toHaveBeenCalledWith("ann", { sourceImage: "data:image/png;base64,abc", sourceImageRef: undefined });
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const outputCall = calls.find((c: unknown[]) => (c[1] as Record<string, unknown>).outputImage !== undefined);
    expect(outputCall).toBeUndefined();
  });

  it("should update pass-through outputImage when upstream changes", async () => {
    // When outputImage === sourceImage, it was a pass-through — should update with new image
    const node = makeNode("ann", "annotation", { outputImage: "old-image", sourceImage: "old-image" });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["new-image"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeAnnotation(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("ann", { sourceImage: "new-image", sourceImageRef: undefined });
    expect(ctx.updateNodeData).toHaveBeenCalledWith("ann", { outputImage: "new-image", outputImageRef: undefined, outputImageThumbKey: null });
  });

  it("should do nothing when no images connected", async () => {
    const node = makeNode("ann", "annotation", { outputImage: null });
    const ctx = makeCtx(node);

    await executeAnnotation(ctx);

    expect(ctx.updateNodeData).not.toHaveBeenCalled();
  });

  it("should set error on exception", async () => {
    const node = makeNode("ann", "annotation", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockImplementation(() => {
        throw new Error("test error");
      }),
    });

    await executeAnnotation(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("ann", { error: "test error" });
  });
});

describe("executePrompt", () => {
  it("should update prompt from connected text", async () => {
    const node = makeNode("p", "prompt", { prompt: "old" });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: "new prompt",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executePrompt(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("p", { prompt: "new prompt" });
  });

  it("should not update prompt when no text connected", async () => {
    const node = makeNode("p", "prompt", { prompt: "keep" });
    const ctx = makeCtx(node);

    await executePrompt(ctx);

    expect(ctx.updateNodeData).not.toHaveBeenCalled();
  });

  it("should set error on exception", async () => {
    const node = makeNode("p", "prompt", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });

    await executePrompt(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("p", { error: "fail" });
  });
});

describe("executePromptConstructor", () => {
  it("should resolve @variables from connected prompt nodes", async () => {
    const pcNode = makeNode("pc", "promptConstructor", {
      template: "Hello @name, welcome to @place",
      outputText: null,
      unresolvedVars: [],
    });
    const promptNode = makeNode("p1", "prompt", { prompt: "World", variableName: "name" });
    const promptNode2 = makeNode("p2", "prompt", { prompt: "Earth", variableName: "place" });

    const edges: WorkflowEdge[] = [
      { id: "e1", source: "p1", target: "pc", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge,
      { id: "e2", source: "p2", target: "pc", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge,
    ];

    const ctx = makeCtx(pcNode, {
      getFreshNode: vi.fn().mockReturnValue(pcNode),
      getEdges: vi.fn().mockReturnValue(edges),
      getNodes: vi.fn().mockReturnValue([pcNode, promptNode, promptNode2]),
    });

    await executePromptConstructor(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("pc", {
      outputText: "Hello World, welcome to Earth",
      unresolvedVars: [],
    });
  });

  it("should track unresolved variables", async () => {
    const pcNode = makeNode("pc", "promptConstructor", {
      template: "Hello @name, welcome to @unknown",
      outputText: null,
      unresolvedVars: [],
    });
    const promptNode = makeNode("p1", "prompt", { prompt: "World", variableName: "name" });

    const edges: WorkflowEdge[] = [
      { id: "e1", source: "p1", target: "pc", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge,
    ];

    const ctx = makeCtx(pcNode, {
      getFreshNode: vi.fn().mockReturnValue(pcNode),
      getEdges: vi.fn().mockReturnValue(edges),
      getNodes: vi.fn().mockReturnValue([pcNode, promptNode]),
    });

    await executePromptConstructor(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("pc", {
      outputText: "Hello World, welcome to @unknown",
      unresolvedVars: ["unknown"],
    });
  });

  it("should use fresh node data", async () => {
    const staleNode = makeNode("pc", "promptConstructor", {
      template: "stale template",
    });
    const freshNode = makeNode("pc", "promptConstructor", {
      template: "fresh @var",
    });

    const ctx = makeCtx(staleNode, {
      getFreshNode: vi.fn().mockReturnValue(freshNode),
      getEdges: vi.fn().mockReturnValue([]),
      getNodes: vi.fn().mockReturnValue([freshNode]),
    });

    await executePromptConstructor(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("pc", {
      outputText: "fresh @var",
      unresolvedVars: ["var"],
    });
  });
});

describe("executeOutput", () => {
  it("should set video content from videos array", async () => {
    const node = makeNode("out", "output", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["data:video/mp4;base64,abc"],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutput(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("out", {
      image: "data:video/mp4;base64,abc",
      video: "data:video/mp4;base64,abc",
      model3d: null,
      contentType: "video",
    });
  });

  it("should set image content from images array", async () => {
    const node = makeNode("out", "output", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,img"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutput(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("out", {
      image: "data:image/png;base64,img",
      video: null,
      model3d: null,
      contentType: "image",
    });
  });

  it("should detect video URLs in images array", async () => {
    const node = makeNode("out", "output", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:video/mp4;base64,vid"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutput(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("out", {
      image: "data:video/mp4;base64,vid",
      video: "data:video/mp4;base64,vid",
      model3d: null,
      contentType: "video",
    });
  });

  it("should detect fal.media URLs as video", async () => {
    const node = makeNode("out", "output", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["https://fal.media/files/abc123.mp4"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutput(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("out", {
      image: "https://fal.media/files/abc123.mp4",
      video: "https://fal.media/files/abc123.mp4",
      model3d: null,
      contentType: "video",
    });
  });
});

describe("executeOutputGallery", () => {
  it("should add new images to gallery", async () => {
    const node = makeNode("gal", "outputGallery", { images: ["existing.png"] });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["new1.png", "new2.png"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutputGallery(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("gal", {
      images: ["new1.png", "new2.png", "existing.png"],
    });
  });

  it("should not add duplicate images", async () => {
    const node = makeNode("gal", "outputGallery", { images: ["existing.png"] });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["existing.png", "new.png"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutputGallery(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("gal", {
      images: ["new.png", "existing.png"],
    });
  });

  it("should not update when no new images", async () => {
    const node = makeNode("gal", "outputGallery", { images: ["existing.png"] });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["existing.png"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeOutputGallery(ctx);

    expect(ctx.updateNodeData).not.toHaveBeenCalled();
  });
});

describe("executeImageCompare", () => {
  it("should set imageA and imageB from connected images", async () => {
    const node = makeNode("cmp", "imageCompare", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["img-a.png", "img-b.png"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeImageCompare(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("cmp", {
      imageA: "img-a.png",
      imageB: "img-b.png",
    });
  });

  it("should handle single image", async () => {
    const node = makeNode("cmp", "imageCompare", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["img-a.png"],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeImageCompare(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("cmp", {
      imageA: "img-a.png",
      imageB: null,
    });
  });

  it("should handle no images", async () => {
    const node = makeNode("cmp", "imageCompare", {});
    const ctx = makeCtx(node);

    await executeImageCompare(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("cmp", {
      imageA: null,
      imageB: null,
    });
  });
});

describe("executeGlbViewer", () => {
  it("should fetch 3D model via proxy and set blob URL", async () => {
    const node = makeNode("glb", "glbViewer", {});
    const mockBlob = new Blob(["fake-glb"], { type: "model/gltf-binary" });
    const mockBlobUrl = "blob:http://localhost/fake-blob-url";

    const mockResponse = { ok: true, blob: () => Promise.resolve(mockBlob) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue(mockBlobUrl);

    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        model3d: "https://example.com/model.glb",
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeGlbViewer(ctx);

    expect(fetchSpy).toHaveBeenCalledWith("/api/proxy-fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/model.glb" }),
    });
    expect(ctx.updateNodeData).toHaveBeenCalledWith("glb", {
      glbUrl: mockBlobUrl,
      filename: "model.glb",
      capturedImage: null,
    });

    fetchSpy.mockRestore();
    createObjectURLSpy.mockRestore();
  });

  it("should set error on fetch failure", async () => {
    const node = makeNode("glb", "glbViewer", {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        model3d: "https://example.com/model.glb",
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeGlbViewer(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("glb", { error: "Network error" });

    fetchSpy.mockRestore();
  });

  it("should do nothing when no model3d input", async () => {
    const node = makeNode("glb", "glbViewer", {});
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        model3d: null,
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeGlbViewer(ctx);

    expect(ctx.updateNodeData).not.toHaveBeenCalled();
  });

  it("should not set error on abort", async () => {
    const node = makeNode("glb", "glbViewer", {});
    const abortError = new DOMException("Aborted", "AbortError");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);

    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        model3d: "https://example.com/model.glb",
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await executeGlbViewer(ctx);

    expect(ctx.updateNodeData).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe("executeBlur", () => {
  const IMG = "data:image/png;base64,SRC";
  const MATTE = "data:image/png;base64,MATTE";

  function blurSetup(edges: WorkflowEdge[], upstream: WorkflowNode[]) {
    const node = makeNode("blur1", "blur", {
      sourceImage: null, matteImage: null, filter: "gaussian", radius: 12,
      angle: 0, invertMatte: false, mixAmount: 0.8, outputImage: null,
    });
    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue(edges),
      getNodes: vi.fn().mockReturnValue([node, ...upstream]),
    });
    return { node, ctx };
  }

  it("routes primary + matte handles, mirrors inputs, and commits with node params", async () => {
    const { commitBlurNode } = await import("@/utils/colorChain");
    vi.mocked(commitBlurNode).mockClear();
    const src = makeNode("in1", "imageInput", { image: IMG });
    const mt = makeNode("in2", "imageInput", { image: MATTE });
    const { ctx } = blurSetup(
      [
        { id: "e1", source: "in1", target: "blur1", targetHandle: "image" } as WorkflowEdge,
        { id: "e2", source: "in2", target: "blur1", targetHandle: "image-blur_matte" } as WorkflowEdge,
      ],
      [src, mt],
    );

    await executeBlur(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("blur1", {
      sourceImage: IMG, sourceImageRef: undefined, matteImage: MATTE, matteImageRef: undefined,
    });
    expect(commitBlurNode).toHaveBeenCalledWith(
      { url: IMG },
      { url: MATTE },
      { filter: "gaussian", radius: 12, angle: 0, invertMatte: false, mixAmount: 0.8 },
      "blur1",
      IMG,
    );
    expect(ctx.updateNodeData).toHaveBeenCalledWith("blur1", {
      outputImage: "data:image/png;base64,BLURRED", outputImageRef: undefined, outputImageThumbKey: null, error: null,
    });
  });

  it("clears a stale output when the source is disconnected", async () => {
    const { commitBlurNode } = await import("@/utils/colorChain");
    vi.mocked(commitBlurNode).mockClear();
    const node = makeNode("blur1", "blur", {
      sourceImage: IMG, matteImage: null, filter: "box", radius: 5,
      angle: 0, invertMatte: false, mixAmount: 1, outputImage: "data:image/png;base64,OLD",
    });
    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([]),
      getNodes: vi.fn().mockReturnValue([node]),
    });

    await executeBlur(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("blur1", { outputImage: null, outputImageRef: undefined, outputImageThumbKey: null });
    expect(commitBlurNode).not.toHaveBeenCalled();
  });
});

describe("executeComp — skip when already current", () => {
  const IMG = "data:image/png;base64,BG";

  function compSetup(compData: Record<string, unknown>) {
    const src = makeNode("in1", "imageInput", { image: IMG, imageRef: "img-bg" });
    const node = makeNode("comp1", "comp", {
      mergeOp: "over", bgImage: null, bgOpacity: 1, fgOpacity: 1, ...compData,
    });
    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "in1", target: "comp1", targetHandle: "image-comp_bg" } as WorkflowEdge,
      ]),
      getNodes: vi.fn().mockReturnValue([node, src]),
    });
    return { ctx, node, src };
  }

  it("composites when there is no recorded signature", async () => {
    const { compositeCompForExecutor } = await import("@/utils/compComposite");
    vi.mocked(compositeCompForExecutor).mockClear();
    const { ctx } = compSetup({});
    await executeComp(ctx);
    expect(compositeCompForExecutor).toHaveBeenCalledTimes(1);
  });

  it("skips the composite when the recorded signature still matches", async () => {
    const { compositeCompForExecutor } = await import("@/utils/compComposite");
    const { compCommitSignature } = await import("@/utils/compSignature");
    vi.mocked(compositeCompForExecutor).mockClear();
    const src = makeNode("in1", "imageInput", { image: IMG, imageRef: "img-bg" });
    const data: Record<string, unknown> = { mergeOp: "over", bgImage: null, bgOpacity: 1, fgOpacity: 1 };
    const sig = compCommitSignature(data, {
      bg: { srcId: "in1", node: src, value: IMG },
      bgAlpha: { srcId: null, node: null, value: null },
      fg: { srcId: null, node: null, value: null },
      fgAlpha: { srcId: null, node: null, value: null },
      matte: { srcId: null, node: null, value: null },
    });
    const node = makeNode("comp1", "comp", { ...data, compCommitSig: sig, outputImage: "data:image/png;base64,OLD" });
    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "in1", target: "comp1", targetHandle: "image-comp_bg" } as WorkflowEdge,
      ]),
      getNodes: vi.fn().mockReturnValue([node, src]),
    });
    await executeComp(ctx);
    expect(compositeCompForExecutor).not.toHaveBeenCalled();
  });

  it("does NOT skip when the signature matches but the output is missing", async () => {
    // A deleted ref file leaves the signature intact and the pixels gone.
    const { compositeCompForExecutor } = await import("@/utils/compComposite");
    const { compCommitSignature } = await import("@/utils/compSignature");
    vi.mocked(compositeCompForExecutor).mockClear();
    const src = makeNode("in1", "imageInput", { image: IMG, imageRef: "img-bg" });
    const data: Record<string, unknown> = { mergeOp: "over", bgImage: null, bgOpacity: 1, fgOpacity: 1 };
    const sig = compCommitSignature(data, {
      bg: { srcId: "in1", node: src, value: IMG },
      bgAlpha: { srcId: null, node: null, value: null },
      fg: { srcId: null, node: null, value: null },
      fgAlpha: { srcId: null, node: null, value: null },
      matte: { srcId: null, node: null, value: null },
    });
    const node = makeNode("comp1", "comp", { ...data, compCommitSig: sig, outputImage: null });
    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "in1", target: "comp1", targetHandle: "image-comp_bg" } as WorkflowEdge,
      ]),
      getNodes: vi.fn().mockReturnValue([node, src]),
    });
    await executeComp(ctx);
    expect(compositeCompForExecutor).toHaveBeenCalledTimes(1);
  });
});
