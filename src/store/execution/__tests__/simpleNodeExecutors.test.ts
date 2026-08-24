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
  executeImageCrop,
} from "../simpleNodeExecutors";

// executeBlur's GPU commit + run-hydration are environment-bound — stub them.
vi.mock("@/utils/colorChain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/colorChain")>();
  return { ...actual, commitBlurNode: vi.fn().mockResolvedValue("data:image/png;base64,BLURRED") };
});
vi.mock("@/store/execution/hydrateForRun", () => ({
  ensureFullResForNodes: vi.fn().mockResolvedValue(undefined),
}));
// jsdom decodes no images, so the crop util is stubbed with the geometry a real
// decode would have produced. The assertions here are about the METADATA the
// executor derives from that geometry, never about pixels.
// PARTIAL mock: only the decode is stubbed. `clampRelativeRegion` is the real
// one — buildCropMetadata shares it so the region it stores and the integers it
// stores describe the same sample, and a mock that dropped it would replace that
// guarantee with an undefined-export crash.
vi.mock("@/utils/cropImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/cropImage")>()),
  cropImageToDataUrl: vi.fn(async (src: string, region: { x: number; y: number; width: number; height: number }) => {
    const srcW = 1920;
    const srcH = 1080;
    const full = region.x === 0 && region.y === 0 && region.width >= 1 && region.height >= 1;
    return full
      ? { dataUrl: src, srcW, srcH, sx: 0, sy: 0, sw: srcW, sh: srcH }
      : {
          dataUrl: "data:image/png;base64,CROPPED",
          srcW,
          srcH,
          sx: Math.round(region.x * srcW),
          sy: Math.round(region.y * srcH),
          sw: Math.max(1, Math.round(region.width * srcW)),
          sh: Math.max(1, Math.round(region.height * srcH)),
        };
  }),
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
    const { compCommitSignature, compPinToken } = await import("@/utils/compSignature");
    vi.mocked(compositeCompForExecutor).mockClear();
    const src = makeNode("in1", "imageInput", { image: IMG, imageRef: "img-bg" });
    const data: Record<string, unknown> = { mergeOp: "over", bgImage: null, bgOpacity: 1, fgOpacity: 1 };
    const sig = compCommitSignature(data, {
      bg: { srcId: "in1", token: compPinToken(src, IMG) },
      bgAlpha: { srcId: null, token: compPinToken(null, null) },
      fg: { srcId: null, token: compPinToken(null, null) },
      fgAlpha: { srcId: null, token: compPinToken(null, null) },
      matte: { srcId: null, token: compPinToken(null, null) },
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
    const { compCommitSignature, compPinToken } = await import("@/utils/compSignature");
    vi.mocked(compositeCompForExecutor).mockClear();
    const src = makeNode("in1", "imageInput", { image: IMG, imageRef: "img-bg" });
    const data: Record<string, unknown> = { mergeOp: "over", bgImage: null, bgOpacity: 1, fgOpacity: 1 };
    const sig = compCommitSignature(data, {
      bg: { srcId: "in1", token: compPinToken(src, IMG) },
      bgAlpha: { srcId: null, token: compPinToken(null, null) },
      fg: { srcId: null, token: compPinToken(null, null) },
      fgAlpha: { srcId: null, token: compPinToken(null, null) },
      matte: { srcId: null, token: compPinToken(null, null) },
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

  /**
   * The `text-comp_fg_align` pin carries the FG's crop placement metadata. It is
   * routed by the same edge loop as the five image pins, which bails on anything
   * that isn't an image — so the text branch has to run BEFORE that guard.
   */
  it("mirrors the align pin's metadata and re-composites because the signature moved", async () => {
    const { compositeCompForExecutor } = await import("@/utils/compComposite");
    const { compCommitSignature, compPinToken } = await import("@/utils/compSignature");
    vi.mocked(compositeCompForExecutor).mockClear();
    const META = '{"v":1,"crop":{"x":0,"y":0,"width":960,"height":540}}';
    const src = makeNode("in1", "imageInput", { image: IMG, imageRef: "img-bg" });
    const crop = makeNode("crop1", "imageCrop", { outputImage: IMG, cropMetadata: META });
    const data: Record<string, unknown> = { mergeOp: "over", bgImage: null, bgOpacity: 1, fgOpacity: 1 };
    // The signature this comp carried before anything was on the align pin.
    const stale = compCommitSignature(data, {
      bg: { srcId: "in1", token: compPinToken(src, IMG) },
      bgAlpha: { srcId: null, token: compPinToken(null, null) },
      fg: { srcId: "crop1", token: compPinToken(crop, IMG) },
      fgAlpha: { srcId: null, token: compPinToken(null, null) },
      matte: { srcId: null, token: compPinToken(null, null) },
    });
    const node = makeNode("comp1", "comp", { ...data, compCommitSig: stale, outputImage: "data:image/png;base64,OLD" });
    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "in1", target: "comp1", targetHandle: "image-comp_bg" } as WorkflowEdge,
        { id: "e2", source: "crop1", target: "comp1", sourceHandle: "image", targetHandle: "image-comp_fg" } as WorkflowEdge,
        { id: "e3", source: "crop1", target: "comp1", sourceHandle: "text", targetHandle: "text-comp_fg_align" } as WorkflowEdge,
      ]),
      getNodes: vi.fn().mockReturnValue([node, src, crop]),
    });
    await executeComp(ctx);
    expect(ctx.updateNodeData).toHaveBeenCalledWith("comp1", expect.objectContaining({ fgAlignMeta: META }));
    expect(compositeCompForExecutor).toHaveBeenCalledTimes(1);
  });

  /**
   * Every comp saved before this pin existed has no `fgAlignMeta` key at all.
   * Mirroring a null onto it would change its stored signature and cost a full
   * recomposite for nothing — so an unconnected pin must leave the field absent.
   */
  it("leaves fgAlignMeta absent when nothing is on the align pin", async () => {
    const { ctx } = compSetup({});
    await executeComp(ctx);
    const mirror = vi.mocked(ctx.updateNodeData).mock.calls
      .find((c) => c[0] === "comp1" && "bgImage" in (c[1] as Record<string, unknown>))?.[1] as Record<string, unknown>;
    expect(mirror).toBeDefined();
    expect(mirror.fgAlignMeta).toBeUndefined();
  });
});

/**
 * The crop node's `text` pin carries the placement metadata a downstream Comp
 * uses to put a generated patch back where the crop came from. `imageCrop` is a
 * LOCAL_PROCESSOR_TYPE, so this executor force-reruns ahead of downstream nodes
 * and overwrites whatever the modal committed — if it does not reproduce the
 * metadata, a run silently drops it.
 */
describe("executeImageCrop — placement metadata", () => {
  const SRC = "data:image/png;base64,SRC";

  function cropCtx(data: Record<string, unknown>, images: string[] = [SRC]) {
    const node = makeNode("crop", "imageCrop", { sourceImage: null, outputImage: null, cropMetadata: null, ...data });
    return makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images, videos: [], audio: [], text: null, dynamicInputs: {}, easeCurve: null,
      }),
    });
  }

  /** The metadata from the last updateNodeData call that carried one. */
  function committedMeta(ctx: NodeExecutionContext) {
    const calls = vi.mocked(ctx.updateNodeData).mock.calls.filter(
      (c) => c[1] && "cropMetadata" in (c[1] as Record<string, unknown>)
    );
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1][1] as { cropMetadata: string | null }).cropMetadata;
  }

  it("emits IDENTITY metadata on the no-region passthrough, not null", async () => {
    const ctx = cropCtx({ cropRegion: null });
    await executeImageCrop(ctx);

    // A connected-but-null pin is the worst outcome: the consumer cannot tell
    // "no crop happened" from "not hydrated yet". The whole frame, in place, is
    // a statement — null is not.
    const meta = committedMeta(ctx);
    expect(meta).not.toBeNull();
    expect(JSON.parse(meta as string)).toEqual({
      v: 1,
      kind: "imageCrop",
      origin: "top-left",
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
      region: { x: 0, y: 0, width: 1, height: 1 },
      emittedWidth: 1920,
      emittedHeight: 1080,
    });
    // Passthrough still publishes the incoming pixels unchanged.
    expect(vi.mocked(ctx.updateNodeData).mock.calls.some(
      (c) => (c[1] as Record<string, unknown>).outputImage === SRC
    )).toBe(true);
  });

  it("emits the sampled rect — the integers drawImage got — for a real crop", async () => {
    const ctx = cropCtx({ cropRegion: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } });
    await executeImageCrop(ctx);

    expect(JSON.parse(committedMeta(ctx) as string)).toEqual({
      v: 1,
      kind: "imageCrop",
      origin: "top-left",
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { x: 480, y: 540, width: 960, height: 270 },
      region: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
      emittedWidth: 960,
      emittedHeight: 270,
    });
  });

  it("clears the metadata when the input goes away", async () => {
    const ctx = cropCtx({ cropRegion: null, outputImage: SRC, cropMetadata: "{}" }, []);
    await executeImageCrop(ctx);
    expect(committedMeta(ctx)).toBeNull();
  });

  /**
   * "No incoming image" is TWO states, and this branch cannot tell them apart:
   * genuinely disconnected, or a saved workflow whose images are still lazily
   * unloaded. `outputImage`/`sourceImage` are externalized (imageFieldMap) and
   * come back null; `cropMetadata` is inline in the workflow JSON and comes back
   * PRESENT AND CORRECT. Clearing on its presence therefore threw away good
   * metadata for a node nobody had touched — and downstream, the Comp's align
   * mirror went null, its stored `compCommitSig` stopped matching, and every
   * aligned comp re-composited (1.0-1.8s each) with align blocked.
   * `outputImage !== null` is the state that can only exist after hydration.
   */
  it("does NOT clear the metadata of a node that is merely un-hydrated", async () => {
    const ctx = cropCtx(
      { cropRegion: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, outputImage: null, cropMetadata: '{"v":1}' },
      [],
    );
    await executeImageCrop(ctx);
    expect(ctx.updateNodeData).not.toHaveBeenCalled();
  });
});
