import { describe, it, expect, vi, beforeEach } from "vitest";

const loadMediaById = vi.fn(async (ref: string) => `data:image/png;base64,LOADED:${ref}`);
vi.mock("@/utils/mediaStorage", () => ({ loadMediaById: (r: string) => loadMediaById(r) }));

import { ensureFullResForNodes } from "../hydrateForRun";
import type { WorkflowNode, WorkflowNodeData } from "@/types";

function node(id: string, type: string, data: Record<string, unknown>): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as WorkflowNode;
}

/**
 * chain: imageInput(in-1) -> imageCrop(crop-1) -> comp(comp-1)
 *
 * Every node is in the lazy on-open state: refs present, raw null.
 */
function chain(opts: { cropHasOutput?: boolean } = {}) {
  const nodes = [
    node("in-1", "imageInput", { image: null, imageRef: "img-source" }),
    node("crop-1", "imageCrop", {
      sourceImage: null,
      sourceImageRef: "img-cropsrc",
      outputImage: null,
      ...(opts.cropHasOutput === false ? {} : { outputImageRef: "img-cropout" }),
    }),
    node("comp-1", "comp", { outputImage: null, outputImageRef: "img-compout" }),
  ];
  const edges = [
    { source: "in-1", target: "crop-1" },
    { source: "crop-1", target: "comp-1" },
  ];
  return { nodes, edges };
}

function refsLoaded(): string[] {
  return loadMediaById.mock.calls.map((c) => c[0] as string).sort();
}

describe("ensureFullResForNodes", () => {
  beforeEach(() => {
    loadMediaById.mockClear();
  });

  it('run mode loads the whole transitive upstream, sources included', async () => {
    const { nodes, edges } = chain();
    await ensureFullResForNodes(["comp-1"], nodes, edges, vi.fn(), "/proj");

    // Everything: the comp's own output, the crop's source AND output, the input.
    expect(refsLoaded()).toEqual(["img-compout", "img-cropout", "img-cropsrc", "img-source"]);
  });

  it("consumer mode stops at a producer that has a committed output", async () => {
    const { nodes, edges } = chain();
    await ensureFullResForNodes(["comp-1"], nodes, edges, vi.fn(), "/proj", "consumer");

    // crop-1 can serve itself from disk, so neither its source nor anything
    // behind it is needed — one upstream file instead of three.
    expect(refsLoaded()).toEqual(["img-compout", "img-cropout"]);
  });

  it("consumer mode traces past a producer with NO committed output", async () => {
    const { nodes, edges } = chain({ cropHasOutput: false });
    await ensureFullResForNodes(["comp-1"], nodes, edges, vi.fn(), "/proj", "consumer");

    // The crop must recompute to produce anything, so it needs its own source,
    // and the input feeding it. Missing these would leave the editor blank.
    expect(refsLoaded()).toEqual(["img-compout", "img-cropsrc", "img-source"]);
  });

  it("consumer mode still loads BOTH source and output for the root itself", async () => {
    const nodes = [
      node("crop-1", "imageCrop", {
        sourceImage: null,
        sourceImageRef: "img-cropsrc",
        outputImage: null,
        outputImageRef: "img-cropout",
      }),
    ];
    await ensureFullResForNodes(["crop-1"], nodes, [], vi.fn(), "/proj", "consumer");

    // The root is the node being displayed — its own source is what its editor shows.
    expect(refsLoaded()).toEqual(["img-cropout", "img-cropsrc"]);
  });

  it("writes each loaded value back to the right node and field", async () => {
    const { nodes, edges } = chain();
    const updates: Array<[string, Partial<WorkflowNodeData>]> = [];
    await ensureFullResForNodes(
      ["comp-1"], nodes, edges,
      (id, d) => { updates.push([id, d]); },
      "/proj", "consumer",
    );

    expect(updates).toContainEqual(["comp-1", { outputImage: "data:image/png;base64,LOADED:img-compout" }]);
    expect(updates).toContainEqual(["crop-1", { outputImage: "data:image/png;base64,LOADED:img-cropout" }]);
  });

  it("skips fields already loaded, and refs that do not exist", async () => {
    const nodes = [
      node("crop-1", "imageCrop", {
        sourceImage: "data:image/png;base64,ALREADY",
        sourceImageRef: "img-cropsrc",
        outputImage: null,
        // no outputImageRef at all
      }),
    ];
    await ensureFullResForNodes(["crop-1"], nodes, [], vi.fn(), "/proj", "consumer");

    expect(refsLoaded()).toEqual([]);
  });

  it("does nothing without a save directory", async () => {
    const { nodes, edges } = chain();
    await ensureFullResForNodes(["comp-1"], nodes, edges, vi.fn(), null, "consumer");
    expect(refsLoaded()).toEqual([]);
  });
});
