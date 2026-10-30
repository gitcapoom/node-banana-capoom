import { describe, it, expect } from "vitest";
import { mergeExternalizedRefs } from "../mergeExternalizedRefs";
import type { WorkflowNode } from "@/types";

const node = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;

describe("mergeExternalizedRefs", () => {
  it("gives a canvas-dropped video its ref, keeping the clip in memory", () => {
    // The real failure: a 55 MB clip dropped on the canvas. The save wrote
    // videoFileRef to the file only, so the live node stayed ref-less and a
    // Run refused the clip as "over the 20 MB limit".
    const live = [node("v", "videoInput", { videoFile: "data:video/mp4;base64,AAAA" })];
    const saved = [node("v", "videoInput", { videoFile: null, videoFileRef: "img-abc" })];
    const out = mergeExternalizedRefs(live, saved)[0].data as Record<string, unknown>;
    expect(out.videoFileRef).toBe("img-abc");
    expect(out.videoFile).toBe("data:video/mp4;base64,AAAA");
  });

  it("copies every ref and ref list, not a fixed set", () => {
    const live = [node("g", "glbViewer", {})];
    const saved = [node("g", "glbViewer", { capturedImageRef: "img-1", imageRefs: ["img-2"], label: "x" })];
    const out = mergeExternalizedRefs(live, saved)[0].data as Record<string, unknown>;
    expect(out.capturedImageRef).toBe("img-1");
    expect(out.imageRefs).toEqual(["img-2"]);
    expect(out.label).toBeUndefined();
  });

  it("keeps nodes added during the save, and newer live data", () => {
    const live = [node("a", "nanoBanana", { outputImage: "new" }), node("b", "prompt", { prompt: "hi" })];
    const saved = [node("a", "nanoBanana", { outputImage: null, outputImageRef: "img-a" })];
    const out = mergeExternalizedRefs(live, saved);
    expect(out[0].data).toMatchObject({ outputImage: "new", outputImageRef: "img-a" });
    expect(out[1]).toBe(live[1]);
  });
});
