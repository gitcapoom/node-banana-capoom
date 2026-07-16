import { describe, it, expect } from "vitest";
import { migrateEdgeHandles, conformEdgesToRenderablePins } from "../pinMigration";
import type { WorkflowNode, WorkflowEdge } from "@/types";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowNode;
const edge = (id: string, target: string, targetHandle: string): WorkflowEdge =>
  ({ id, source: "s", target, sourceHandle: "image", targetHandle }) as WorkflowEdge;
const handles = (edges: WorkflowEdge[]) => edges.map((e) => e.targetHandle);

describe("migrateEdgeHandles", () => {
  it("classic → dynamic for a schemaless generator (primary image + prompt)", () => {
    const nodes = [node("gen", "nanoBanana")];
    const edges = [edge("e1", "gen", "image"), edge("e2", "gen", "image"), edge("e3", "gen", "text")];
    expect(handles(migrateEdgeHandles(nodes, edges, "dynamic"))).toEqual([
      "dynpin__image__primary__0",
      "dynpin__image__primary__1",
      "dynpin__text__prompt__0",
    ]);
  });

  it("round-trips schemaless edges classic → dynamic → classic", () => {
    const nodes = [node("gen", "nanoBanana")];
    const edges = [edge("e1", "gen", "image"), edge("e2", "gen", "image"), edge("e3", "gen", "text")];
    const dyn = migrateEdgeHandles(nodes, edges, "dynamic");
    expect(handles(migrateEdgeHandles(nodes, dyn, "classic"))).toEqual(["image", "image-1", "text"]);
  });

  it("maps named schema image fields by position and round-trips", () => {
    const nodes = [
      node("gen", "generateVideo", {
        inputSchema: [
          { name: "image_urls", type: "image", isArray: true },
          { name: "mask_url", type: "image" },
          { name: "prompt", type: "text" },
        ],
      }),
    ];
    // classic: two images on the array handle, one on the mask handle, a prompt
    const edges = [
      edge("e1", "gen", "image"),
      edge("e2", "gen", "image"),
      edge("e3", "gen", "image-1"),
      edge("e4", "gen", "text"),
    ];
    const dyn = migrateEdgeHandles(nodes, edges, "dynamic");
    expect(handles(dyn)).toEqual([
      "dynpin__image__image_urls__0",
      "dynpin__image__image_urls__1",
      "dynpin__image__mask_url__0",
      "dynpin__text__prompt__0",
    ]);
    expect(handles(migrateEdgeHandles(nodes, dyn, "classic"))).toEqual(["image", "image", "image-1", "text"]);
  });

  it("router: image edges become primary slots; non-image left alone; collapses back", () => {
    const nodes = [node("r", "router")];
    const edges = [
      edge("e1", "r", "image"),
      edge("e2", "r", "image"),
      edge("e3", "r", "image"),
      edge("e4", "r", "text"), // non-image — image-first, untouched
    ];
    const dyn = migrateEdgeHandles(nodes, edges, "dynamic");
    expect(handles(dyn)).toEqual([
      "dynpin__image__primary__0",
      "dynpin__image__primary__1",
      "dynpin__image__primary__2",
      "text",
    ]);
    // Classic collapses every image slot back to the single "image" handle.
    expect(handles(migrateEdgeHandles(nodes, dyn, "classic"))).toEqual(["image", "image", "image", "text"]);
  });

  it("converting a classic edge skips slots already used by dyn-pin edges (no collision)", () => {
    const nodes = [node("r", "router")];
    const edges = [
      edge("e1", "r", "dynpin__image__primary__0"), // already dynamic, occupies slot 0
      edge("e2", "r", "image"), // classic — must become slot 1, not collide
    ];
    expect(handles(migrateEdgeHandles(nodes, edges, "dynamic"))).toEqual([
      "dynpin__image__primary__0",
      "dynpin__image__primary__1",
    ]);
  });

  it("never migrates the special image-feedback / image-bg handles (loopback wire survives reload)", () => {
    const nodes = [node("llm", "llmGenerate")];
    const edges = [
      edge("e1", "llm", "image-feedback"), // loopback feedback wire — must stay put
      edge("e2", "llm", "image-bg"), // background image — must stay put
      edge("e3", "llm", "image"), // a real reference — SHOULD migrate
    ];
    const dyn = migrateEdgeHandles(nodes, edges, "dynamic");
    expect(handles(dyn)).toEqual(["image-feedback", "image-bg", "dynpin__image__primary__0"]);
    // and the special handles survive the reverse pass too
    expect(handles(migrateEdgeHandles(nodes, dyn, "classic"))).toEqual(["image-feedback", "image-bg", "image"]);
  });

  it("leaves nested element slots and non-generator edges untouched", () => {
    const nodes = [node("gen", "generateVideo"), node("out", "output")];
    const edges = [
      edge("e1", "gen", "dynpin__image__elements.0.frontal_image_url__0"),
      edge("e2", "out", "image"),
    ];
    const back = migrateEdgeHandles(nodes, edges, "classic");
    expect(back[0].targetHandle).toBe("dynpin__image__elements.0.frontal_image_url__0");
    expect(back[1].targetHandle).toBe("image");
  });
});

describe("conformEdgesToRenderablePins", () => {
  const gen = (type: string, inputs?: Array<{ name: string; type: string; isArray?: boolean }>) =>
    node("gen", type, inputs ? { inputSchema: inputs } : {});

  it("moves edges from a vanished field to the new same-type field (array append)", () => {
    // Model switched: old schema had image_urls[], new one has image_input[].
    const edges = [
      edge("e0", "gen", "dynpin__image__image_urls__0"),
      edge("e1", "gen", "dynpin__image__image_urls__1"),
    ];
    const out = conformEdgesToRenderablePins(gen("nanoBanana", [
      { name: "prompt", type: "text" },
      { name: "image_input", type: "image", isArray: true },
    ]), edges)!;
    expect(handles(out)).toEqual([
      "dynpin__image__image_input__0",
      "dynpin__image__image_input__1",
    ]);
  });

  it("primary edges on a schema WITH an image field move into that field (generateVideo case)", () => {
    const edges = [edge("e0", "gen", "dynpin__image__primary__0")];
    const out = conformEdgesToRenderablePins(gen("generateVideo", [
      { name: "prompt", type: "text" },
      { name: "image_url", type: "image" },
    ]), edges)!;
    expect(handles(out)).toEqual(["dynpin__image__image_url__0"]);
  });

  it("primary edges on a schema WITHOUT image fields stay (kie models render reference pins)", () => {
    const edges = [edge("e0", "gen", "dynpin__image__primary__0")];
    expect(conformEdgesToRenderablePins(gen("nanoBanana", [
      { name: "prompt", type: "text" },
    ]), edges)).toBeNull();
  });

  it("stacked scalar slots collapse to the newest at slot 0 (llmGenerate fallback prompt)", () => {
    const edges = [
      edge("e0", "gen", "dynpin__text__prompt__0"),
      edge("e1", "gen", "dynpin__text__prompt__1"),
    ];
    const out = conformEdgesToRenderablePins(gen("llmGenerate"), edges)!;
    expect(out.map((e) => e.id)).toEqual(["e1"]);
    expect(out[0].targetHandle).toBe("dynpin__text__prompt__0");
  });

  it("drops edges with no home; keeps conforming edges untouched (null)", () => {
    const schema = [{ name: "image_url", type: "image" }];
    // video edge on a schema without video inputs → dropped
    const out = conformEdgesToRenderablePins(gen("generateVideo", schema), [
      edge("e0", "gen", "dynpin__video__video_url__0"),
      edge("e1", "gen", "dynpin__image__image_url__0"),
    ])!;
    expect(out.map((e) => e.id)).toEqual(["e1"]);
    // fully conforming set → null (no change)
    expect(conformEdgesToRenderablePins(gen("generateVideo", schema), [
      edge("e1", "gen", "dynpin__image__image_url__0"),
    ])).toBeNull();
  });
});
