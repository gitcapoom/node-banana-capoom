/**
 * Which edges the canvas allows.
 *
 * This logic had no real coverage — the one test naming isValidConnection only
 * asserted the callback was wired to ReactFlow. That is how a video pin on the
 * LLM node shipped looking correct and refusing every connection: the pin
 * rendered, the routing worked, the executor handled it, and the canvas said
 * no on the way in.
 */

import { describe, it, expect } from "vitest";
import { canConnect, type ConnNode } from "../connectionRules";

const node = (type: string, data: unknown = {}): ConnNode => ({ type, data });

describe("video sources", () => {
  it("connects to the LLM node's video pin", () => {
    // The reported bug. llmGenerate was absent from a hardcoded list of target
    // node types, so the edge was refused however correct the pin was.
    expect(
      canConnect({
        sourceType: "video",
        targetType: "video",
        sourceNode: node("videoInput"),
        targetNode: node("llmGenerate"),
      })
    ).toBe(true);
  });

  it("connects to any node that declares a video handle", () => {
    // The general form of the same bug: a node type nobody listed.
    expect(
      canConnect({
        sourceType: "video",
        targetType: "video",
        sourceNode: node("videoInput"),
        targetNode: node("someFutureNode"),
      })
    ).toBe(true);
  });

  it("still connects to video nodes whose handle is not typed video", () => {
    // videoStitch uses video-0/video-1 and output uses `universal`; these are
    // why the node-type list has to stay.
    for (const t of ["generateVideo", "videoStitch", "videoCompare", "videoTrim", "videoFrameGrab", "router"]) {
      expect(
        canConnect({ sourceType: "video", targetType: "image", sourceNode: node("videoInput"), targetNode: node(t) })
      ).toBe(true);
    }
  });

  it("is refused by a node with no video input at all", () => {
    expect(
      canConnect({
        sourceType: "video",
        targetType: "image",
        sourceNode: node("videoInput"),
        targetNode: node("annotation"),
      })
    ).toBe(false);
  });

  it("reaches a generator only when its model schema declares a video input", () => {
    const withVideo = node("nanoBanana", { inputSchema: [{ type: "video" }] });
    const without = node("nanoBanana", { inputSchema: [{ type: "image" }] });
    expect(canConnect({ sourceType: "video", targetType: "image", targetNode: withVideo })).toBe(true);
    expect(canConnect({ sourceType: "video", targetType: "image", targetNode: without })).toBe(false);
  });
});

describe("audio sources", () => {
  it("connects to a declared audio handle", () => {
    expect(canConnect({ sourceType: "audio", targetType: "audio", targetNode: node("llmGenerate") })).toBe(true);
  });

  it("is refused elsewhere", () => {
    expect(canConnect({ sourceType: "audio", targetType: "image", targetNode: node("annotation") })).toBe(false);
  });
});

describe("ordinary type matching", () => {
  it("matches like with like", () => {
    expect(canConnect({ sourceType: "image", targetType: "image" })).toBe(true);
    expect(canConnect({ sourceType: "text", targetType: "text" })).toBe(true);
  });

  it("refuses a mismatch", () => {
    expect(canConnect({ sourceType: "image", targetType: "text" })).toBe(false);
    expect(canConnect({ sourceType: "text", targetType: "image" })).toBe(false);
  });

  it("allows anything when a type cannot be determined", () => {
    expect(canConnect({ sourceType: null, targetType: "image" })).toBe(true);
    expect(canConnect({ sourceType: "image", targetType: null })).toBe(true);
  });
});

describe("universal and 3d", () => {
  it("the output node takes any medium but text", () => {
    expect(canConnect({ sourceType: "image", targetType: "universal" })).toBe(true);
    expect(canConnect({ sourceType: "video", targetType: "universal" })).toBe(true);
    expect(canConnect({ sourceType: "text", targetType: "universal" })).toBe(false);
  });

  it("3d joins 3d, the output node, or a router", () => {
    expect(canConnect({ sourceType: "3d", targetType: "3d" })).toBe(true);
    expect(canConnect({ sourceType: "3d", targetType: "image", targetNode: node("output") })).toBe(true);
    expect(canConnect({ sourceType: "3d", targetType: "image", targetNode: node("annotation") })).toBe(false);
  });
});

describe("switch and conditional switch", () => {
  it("the generic switch input takes anything", () => {
    expect(
      canConnect({ sourceType: "video", targetType: null, targetNode: node("switch"), targetHandle: "generic-input" })
    ).toBe(true);
  });

  it("a switch output matches whatever it was fed", () => {
    const sw = node("switch", { inputType: "image" });
    expect(canConnect({ sourceType: "image", targetType: "image", sourceNode: sw })).toBe(true);
    expect(canConnect({ sourceType: "image", targetType: "text", sourceNode: sw })).toBe(false);
  });

  it("an unresolved switch allows the connection", () => {
    expect(canConnect({ sourceType: "image", targetType: "text", sourceNode: node("switch", {}) })).toBe(true);
  });

  it("the conditional switch is text in, text out", () => {
    expect(canConnect({ sourceType: "text", targetType: "text", targetNode: node("conditionalSwitch") })).toBe(true);
    expect(canConnect({ sourceType: "image", targetType: "text", targetNode: node("conditionalSwitch") })).toBe(false);
    expect(canConnect({ sourceType: "text", targetType: "text", sourceNode: node("conditionalSwitch") })).toBe(true);
    expect(canConnect({ sourceType: "text", targetType: "image", sourceNode: node("conditionalSwitch") })).toBe(false);
  });
});

describe("easeCurve", () => {
  it("joins easeCurve nodes only", () => {
    expect(
      canConnect({ sourceType: "easeCurve", targetType: "easeCurve", targetNode: node("easeCurve") })
    ).toBe(true);
    expect(
      canConnect({ sourceType: "easeCurve", targetType: "easeCurve", targetNode: node("generateVideo") })
    ).toBe(false);
    expect(canConnect({ sourceType: "easeCurve", targetType: "image", targetNode: node("easeCurve") })).toBe(false);
  });

  it("passes through a router", () => {
    expect(canConnect({ sourceType: "easeCurve", targetType: "image", targetNode: node("router") })).toBe(true);
  });
});
