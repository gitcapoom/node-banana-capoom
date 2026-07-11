import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConnectedInputsPure, validateWorkflowPure } from "../connectedInputs";
import type { WorkflowNode, WorkflowEdge } from "@/types";
import { setDynamicPinsEnabled } from "@/lib/dynamicPins";
import { dynPinId } from "@/lib/dynamicPinId";

function makeNode(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

function makeEdge(source: string, target: string, targetHandle?: string): WorkflowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: "image",
    targetHandle: targetHandle || "image",
  } as WorkflowEdge;
}

describe("getConnectedInputsPure — dynamic pins flag", () => {
  beforeEach(() => setDynamicPinsEnabled(true));
  afterEach(() => setDynamicPinsEnabled(false));

  const dynEdge = (source: string, target: string, handle: string): WorkflowEdge =>
    ({ id: `${source}-${handle}`, source, target, sourceHandle: "image", targetHandle: handle }) as WorkflowEdge;

  it("aggregates primary-image dyn-pin slots into images[]", () => {
    const nodes = [
      makeNode("a", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("b", "imageInput", { image: "data:image/png;base64,b" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [
      dynEdge("a", "gen", dynPinId("image", "primary", 0)),
      dynEdge("b", "gen", dynPinId("image", "primary", 1)),
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,a", "data:image/png;base64,b"]);
    // "primary" is the generic input — it must not leak into dynamicInputs.
    expect(result.dynamicInputs).toEqual({});
  });

  it("routes named array-field dyn-pin slots into dynamicInputs[field]", () => {
    const nodes = [
      makeNode("a", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("b", "imageInput", { image: "data:image/png;base64,b" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [
      dynEdge("a", "gen", dynPinId("image", "image_urls", 0)),
      dynEdge("b", "gen", dynPinId("image", "image_urls", 1)),
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.dynamicInputs.image_urls).toEqual([
      "data:image/png;base64,a",
      "data:image/png;base64,b",
    ]);
  });

  it("assembles repeatable-group dyn pins into nested dynamicInputs paths", () => {
    const nodes = [
      makeNode("f0", "imageInput", { image: "frontal0" }),
      makeNode("r0a", "imageInput", { image: "ref0a" }),
      makeNode("r0b", "imageInput", { image: "ref0b" }),
      makeNode("v0", "generateVideo", { outputVideo: "vid0" }),
      makeNode("gen", "generateVideo", {
        inputSchema: [
          {
            name: "elements",
            type: "image",
            repeatable: true,
            children: [
              { name: "frontal_image_url", type: "image", isArray: false },
              { name: "reference_image_urls", type: "image", isArray: true },
              { name: "video_url", type: "video", isArray: false },
            ],
          },
        ],
      }),
    ];
    const edges = [
      dynEdge("f0", "gen", dynPinId("image", "elements.0.frontal_image_url", 0)),
      dynEdge("r0a", "gen", dynPinId("image", "elements.0.reference_image_urls", 0)),
      dynEdge("r0b", "gen", dynPinId("image", "elements.0.reference_image_urls", 1)),
      {
        id: "v0-gen",
        source: "v0",
        target: "gen",
        sourceHandle: "video",
        targetHandle: dynPinId("video", "elements.0.video_url", 0),
      } as WorkflowEdge,
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    // Scalar children stay scalar; array child accumulates.
    expect(result.dynamicInputs["elements.0.frontal_image_url"]).toBe("frontal0");
    expect(result.dynamicInputs["elements.0.reference_image_urls"]).toEqual(["ref0a", "ref0b"]);
    expect(result.dynamicInputs["elements.0.video_url"]).toBe("vid0");
  });

  it("translates stable @-tokens in the prompt to positional tokens at submit", () => {
    const nodes = [
      makeNode("a", "imageInput", { image: "imgA" }),
      makeNode("b", "imageInput", { image: "imgB" }),
      makeNode("p", "prompt", { prompt: "@ImageA next to @ImageB" }),
      makeNode("gen", "generateVideo", {
        inputSchema: [
          { name: "image_urls", type: "image", isArray: true, refConvention: "Image" },
          { name: "prompt", type: "text" },
        ],
      }),
    ];
    const edges = [
      dynEdge("a", "gen", dynPinId("image", "image_urls", 0)),
      dynEdge("b", "gen", dynPinId("image", "image_urls", 1)),
      {
        id: "p-gen",
        source: "p",
        target: "gen",
        sourceHandle: "text",
        targetHandle: dynPinId("text", "prompt", 0),
      } as WorkflowEdge,
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("@Image1 next to @Image2");
  });

  it("keeps a stable token valid after a middle reference is removed", () => {
    // Only slot 1 (@ImageB) is connected; slot 0 (@ImageA) was deleted.
    const nodes = [
      makeNode("b", "imageInput", { image: "imgB" }),
      makeNode("p", "prompt", { prompt: "use @ImageB and @ImageA" }),
      makeNode("gen", "generateVideo", {
        inputSchema: [
          { name: "image_urls", type: "image", isArray: true, refConvention: "Image" },
          { name: "prompt", type: "text" },
        ],
      }),
    ];
    const edges = [
      dynEdge("b", "gen", dynPinId("image", "image_urls", 1)),
      {
        id: "p-gen",
        source: "p",
        target: "gen",
        sourceHandle: "text",
        targetHandle: dynPinId("text", "prompt", 0),
      } as WorkflowEdge,
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    // @ImageB → @Image1 (it's now the only/first image); @ImageA dropped.
    expect(result.text).toBe("use @Image1 and ");
  });

  it("compacts repeatable-group items and translates @Element tokens", () => {
    const nodes = [
      makeNode("a", "imageInput", { image: "imgA" }),
      makeNode("c", "imageInput", { image: "imgC" }),
      makeNode("p", "prompt", { prompt: "@ElementA meets @ElementC" }),
      makeNode("gen", "generateVideo", {
        inputSchema: [
          {
            name: "elements",
            type: "image",
            repeatable: true,
            refConvention: "Element",
            children: [{ name: "frontal_image_url", type: "image", isArray: false }],
          },
          { name: "prompt", type: "text" },
        ],
      }),
    ];
    // Connect item 0 and item 2 (skip 1) to prove the array compacts.
    const edges = [
      dynEdge("a", "gen", dynPinId("image", "elements.0.frontal_image_url", 0)),
      dynEdge("c", "gen", dynPinId("image", "elements.2.frontal_image_url", 0)),
      {
        id: "p-gen",
        source: "p",
        target: "gen",
        sourceHandle: "text",
        targetHandle: dynPinId("text", "prompt", 0),
      } as WorkflowEdge,
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    // item 0 → rank 0 (elements.0), item 2 → rank 1 (elements.1): dense, no hole.
    expect(result.dynamicInputs["elements.0.frontal_image_url"]).toBe("imgA");
    expect(result.dynamicInputs["elements.1.frontal_image_url"]).toBe("imgC");
    expect(result.dynamicInputs["elements.2.frontal_image_url"]).toBeUndefined();
    // @ElementA (item 0) → @Element1; @ElementC (item 2) → @Element2.
    expect(result.text).toBe("@Element1 meets @Element2");
  });

  it("resolves a generator's prompt tokens through a router bundle", () => {
    const nodes = [
      makeNode("imgA", "imageInput", { image: "A" }),
      makeNode("imgB", "imageInput", { image: "B" }),
      makeNode("r", "router", { refNames: { "1": "Hero" } }),
      makeNode("p", "prompt", { prompt: "@A next to @Hero" }),
      makeNode("gen", "generateVideo", {
        inputSchema: [
          { name: "image_urls", type: "image", isArray: true, refConvention: "Image" },
          { name: "prompt", type: "text" },
        ],
      }),
    ];
    const edges = [
      dynEdge("imgA", "r", dynPinId("image", "primary", 0)),
      dynEdge("imgB", "r", dynPinId("image", "primary", 1)),
      // router output ("image") → generator's image_urls pin
      dynEdge("r", "gen", dynPinId("image", "image_urls", 0)),
      {
        id: "p-gen",
        source: "p",
        target: "gen",
        sourceHandle: "text",
        targetHandle: dynPinId("text", "prompt", 0),
      } as WorkflowEdge,
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    // The 5-image-style bundle flows through to the field, in router slot order.
    expect(result.dynamicInputs.image_urls).toEqual(["A", "B"]);
    // @A → router slot 0 → @Image1; @Hero (named slot 1) → @Image2.
    expect(result.text).toBe("@Image1 next to @Image2");
  });

  it("resolves router tokens to ordinal phrases for a non-@-convention generator", () => {
    const nodes = [
      makeNode("imgA", "imageInput", { image: "A" }),
      makeNode("imgB", "imageInput", { image: "B" }),
      makeNode("imgC", "imageInput", { image: "C" }),
      makeNode("r", "router", {}),
      makeNode("p", "prompt", { prompt: "@A on the left, @C on the right, @B in the middle" }),
      makeNode("gen", "nanoBanana", {
        inputSchema: [
          { name: "image_urls", type: "image", isArray: true }, // NO refConvention
          { name: "prompt", type: "text" },
        ],
      }),
    ];
    const edges = [
      dynEdge("imgA", "r", dynPinId("image", "primary", 0)),
      dynEdge("imgB", "r", dynPinId("image", "primary", 1)),
      dynEdge("imgC", "r", dynPinId("image", "primary", 2)),
      dynEdge("r", "gen", dynPinId("image", "image_urls", 0)),
      {
        id: "p-gen",
        source: "p",
        target: "gen",
        sourceHandle: "text",
        targetHandle: dynPinId("text", "prompt", 0),
      } as WorkflowEdge,
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe(
      "the first image on the left, the third image on the right, the second image in the middle"
    );
  });

  it("ignores the dyn-pin scheme when the flag is off (classic routing)", () => {
    setDynamicPinsEnabled(false);
    const nodes = [
      makeNode("a", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [dynEdge("a", "gen", dynPinId("image", "primary", 0))];
    const result = getConnectedInputsPure("gen", nodes, edges);
    // Routed as a generic image via source type; no dynamicInputs entry.
    expect(result.images).toEqual(["data:image/png;base64,a"]);
    expect(result.dynamicInputs).toEqual({});
  });
});

describe("getConnectedInputsPure", () => {
  it("should return empty arrays when no edges connect to node", () => {
    const nodes = [makeNode("a", "prompt")];
    const result = getConnectedInputsPure("a", nodes, []);
    expect(result.images).toEqual([]);
    expect(result.videos).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.text).toBeNull();
    expect(result.dynamicInputs).toEqual({});
    expect(result.easeCurve).toBeNull();
  });

  it("should extract image from imageInput source", () => {
    const nodes = [
      makeNode("img", "imageInput", { image: "data:image/png;base64,abc" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("img", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,abc"]);
  });

  it("should extract text from prompt source", () => {
    const nodes = [
      makeNode("p", "prompt", { prompt: "hello world" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("p", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("hello world");
  });

  it("should extract image from annotation output", () => {
    const nodes = [
      makeNode("ann", "annotation", { outputImage: "data:image/png;base64,xyz" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("ann", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,xyz"]);
  });

  it("should extract image from nanoBanana output", () => {
    const nodes = [
      makeNode("nb", "nanoBanana", { outputImage: "data:image/png;base64,nb" }),
      makeNode("out", "output"),
    ];
    const edges = [makeEdge("nb", "out", "image")];
    const result = getConnectedInputsPure("out", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,nb"]);
  });

  it("should extract video from generateVideo source", () => {
    const nodes = [
      makeNode("vid", "generateVideo", { outputVideo: "data:video/mp4;base64,vid" }),
      makeNode("out", "output"),
    ];
    const edges = [makeEdge("vid", "out", "image")];
    const result = getConnectedInputsPure("out", nodes, edges);
    expect(result.videos).toEqual(["data:video/mp4;base64,vid"]);
  });

  it("should extract text from llmGenerate source", () => {
    const nodes = [
      makeNode("llm", "llmGenerate", { outputText: "generated text" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("llm", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("generated text");
  });

  it("should extract full array JSON from array node default text output", () => {
    const nodes = [
      makeNode("arr", "array", { outputText: "[\"one\",\"two\"]", outputItems: ["one", "two"] }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [{
      id: "arr-gen",
      source: "arr",
      target: "gen",
      sourceHandle: "text",
      targetHandle: "text",
    }] as WorkflowEdge[];

    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("[\"one\",\"two\"]");
  });

  it("should extract indexed item from array node dynamic output handle", () => {
    const nodes = [
      makeNode("arr", "array", { outputText: "[\"one\",\"two\"]", outputItems: ["one", "two"] }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [{
      id: "arr-gen-item",
      source: "arr",
      target: "gen",
      sourceHandle: "text-1",
      targetHandle: "text",
    }] as WorkflowEdge[];

    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("two");
  });

  it("should extract indexed item from array node edge metadata index", () => {
    const nodes = [
      makeNode("arr", "array", { outputText: "[\"one\",\"two\",\"three\"]", outputItems: ["one", "two", "three"] }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [{
      id: "arr-gen-meta",
      source: "arr",
      target: "gen",
      sourceHandle: "text",
      targetHandle: "text",
      data: { arrayItemIndex: 2 },
    }] as WorkflowEdge[];

    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("three");
  });

  it("should wrap out-of-bounds arrayItemIndex via modulo", () => {
    const nodes = [
      makeNode("arr", "array", { outputText: "[\"one\",\"two\"]", outputItems: ["one", "two"] }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [{
      id: "arr-gen-stale",
      source: "arr",
      target: "gen",
      sourceHandle: "text",
      targetHandle: "text",
      data: { arrayItemIndex: 3 }, // index 3 on 2-item array wraps to index 1
    }] as WorkflowEdge[];

    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("two");
  });

  it("should return null for out-of-bounds arrayItemIndex on empty array", () => {
    const nodes = [
      makeNode("arr", "array", { outputText: "[]", outputItems: [] }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [{
      id: "arr-gen-empty",
      source: "arr",
      target: "gen",
      sourceHandle: "text",
      targetHandle: "text",
      data: { arrayItemIndex: 0 },
    }] as WorkflowEdge[];

    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBeNull();
  });

  it("should wrap large arrayItemIndex correctly", () => {
    const nodes = [
      makeNode("arr", "array", { outputText: "[\"a\",\"b\",\"c\"]", outputItems: ["a", "b", "c"] }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [{
      id: "arr-gen-large",
      source: "arr",
      target: "gen",
      sourceHandle: "text",
      targetHandle: "text",
      data: { arrayItemIndex: 7 }, // 7 % 3 = 1
    }] as WorkflowEdge[];

    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("b");
  });

  it("should extract text from promptConstructor outputText", () => {
    const nodes = [
      makeNode("pc", "promptConstructor", { outputText: "constructed", template: "tmpl" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("pc", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("constructed");
  });

  it("should fallback to template when promptConstructor has no outputText", () => {
    const nodes = [
      makeNode("pc", "promptConstructor", { outputText: null, template: "tmpl" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("pc", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("tmpl");
  });

  it("should skip source nodes with null output", () => {
    const nodes = [
      makeNode("img", "imageInput", { image: null }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("img", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual([]);
  });

  it("should handle multiple image inputs", () => {
    const nodes = [
      makeNode("img1", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("img2", "imageInput", { image: "data:image/png;base64,b" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [
      makeEdge("img1", "gen", "image"),
      makeEdge("img2", "gen", "image"),
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,a", "data:image/png;base64,b"]);
  });

  it("should populate dynamicInputs with schema mapping", () => {
    const nodes = [
      makeNode("img", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("gen", "nanoBanana", {
        inputSchema: [{ name: "image_url", type: "image" }],
      }),
    ];
    // Convention: first schema input of a type maps to the bare handle ("image")
    const edges = [makeEdge("img", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.dynamicInputs).toEqual({ image_url: "data:image/png;base64,a" });
  });

  it("should extract easeCurve data", () => {
    const nodes = [
      makeNode("ec", "easeCurve", {
        bezierHandles: [0.25, 0.1, 0.25, 1.0],
        easingPreset: "ease-in-out",
        outputDuration: 8,
        outputVideo: null,
      }),
      makeNode("vs", "videoStitch"),
    ];
    const edges = [{
      id: "ec-vs",
      source: "ec",
      target: "vs",
      sourceHandle: "easeCurve",
      targetHandle: "easeCurve",
    }] as WorkflowEdge[];
    const result = getConnectedInputsPure("vs", nodes, edges);
    expect(result.easeCurve).toEqual({
      bezierHandles: [0.25, 0.1, 0.25, 1.0],
      easingPreset: "ease-in-out",
      outputDuration: 8,
    });
  });

  it("should extract capturedImage from glbViewer source", () => {
    const nodes = [
      makeNode("glb", "glbViewer", { capturedImage: "data:image/png;base64,snap" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("glb", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,snap"]);
  });

  it("should return empty images when glbViewer has no capture", () => {
    const nodes = [
      makeNode("glb", "glbViewer", { capturedImage: null }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("glb", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual([]);
  });

  it("should extract audio from audioInput source", () => {
    const nodes = [
      makeNode("aud", "audioInput", { audioFile: "data:audio/wav;base64,abc" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("aud", "gen", "audio")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.audio).toEqual(["data:audio/wav;base64,abc"]);
  });
});

describe("validateWorkflowPure", () => {
  it("should fail for empty workflow", () => {
    const result = validateWorkflowPure([], []);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow is empty");
  });

  it("should pass for valid workflow", () => {
    const nodes = [
      makeNode("p", "prompt"),
      makeNode("gen", "nanoBanana"),
      makeNode("out", "output"),
    ];
    const edges = [
      makeEdge("p", "gen", "text"),
      makeEdge("gen", "out"),
    ];
    const result = validateWorkflowPure(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should detect missing text input on nanoBanana", () => {
    const nodes = [makeNode("gen", "nanoBanana")];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing text input");
  });

  it("should detect missing text input on generateVideo", () => {
    const nodes = [makeNode("vid", "generateVideo")];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing text input");
  });

  it("should detect missing image input on annotation without manual image", () => {
    const nodes = [makeNode("ann", "annotation", { sourceImage: null })];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing image input");
  });

  it("should pass annotation with manual image", () => {
    const nodes = [makeNode("ann", "annotation", { sourceImage: "data:image/png;base64,x" })];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(true);
  });

  it("should detect missing image input on output", () => {
    const nodes = [makeNode("out", "output")];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing image input");
  });

  it("should accept text-0 handle for nanoBanana", () => {
    const nodes = [makeNode("p", "prompt"), makeNode("gen", "nanoBanana")];
    const edges = [makeEdge("p", "gen", "text-0")];
    const result = validateWorkflowPure(nodes, edges);
    expect(result.valid).toBe(true);
  });
});
