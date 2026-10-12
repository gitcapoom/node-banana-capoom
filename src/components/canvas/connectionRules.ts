/**
 * May this edge be drawn?
 *
 * Extracted from WorkflowCanvas's `isValidConnection`, which was a closure over
 * `nodes` and therefore untestable — the only test touching it asserted that
 * the callback was "configured". That gap let a real bug through: the video
 * branch allowed a hardcoded list of target node TYPES, so when llmGenerate
 * gained a video pin the canvas still refused every edge into it. The pin
 * rendered, which made it look like the feature worked.
 *
 * The rule now leads with the same type match the function already ended with:
 * a handle that declares itself `video` accepts video. The node-type list is
 * kept beneath it, because some nodes expose video through handles that are not
 * typed `video` (videoStitch's `video-0`, the output node's `universal`), and
 * removing it would break those.
 */

export type HandleType =
  | "image"
  | "text"
  | "video"
  | "audio"
  | "3d"
  | "easeCurve"
  | "universal"
  | null;

/** The slice of a node this decision needs. */
export interface ConnNode {
  type?: string;
  data?: unknown;
}

export interface ConnectionCheck {
  sourceType: HandleType;
  targetType: HandleType;
  sourceNode?: ConnNode;
  targetNode?: ConnNode;
  /** Raw target handle id, for the generic handles that are matched by name. */
  targetHandle?: string | null;
}

/** Target node types that accept video through a handle not typed `video`. */
const VIDEO_TARGET_NODE_TYPES = new Set([
  "generateVideo",
  "videoStitch",
  "videoCompare",
  "easeCurve",
  "videoTrim",
  "videoFrameGrab",
  "output",
  "router",
]);

/** Nodes whose video acceptance depends on the selected model's schema. */
const SCHEMA_DRIVEN_VIDEO_TARGETS = new Set(["nanoBanana", "generate3d"]);
const SCHEMA_DRIVEN_AUDIO_TARGETS = new Set(["nanoBanana", "generateVideo", "generate3d"]);

function schemaHasType(node: ConnNode | undefined, type: string): boolean {
  const data = node?.data as { inputSchema?: Array<{ type?: string }> } | undefined;
  return !!data?.inputSchema?.some((i) => i.type === type);
}

export function canConnect({
  sourceType,
  targetType,
  sourceNode,
  targetNode,
  targetHandle,
}: ConnectionCheck): boolean {
  // Switch input: the generic handle takes anything.
  if (targetNode?.type === "switch" && targetHandle === "generic-input") return true;

  // Switch output: its type is whatever it was fed.
  if (sourceNode?.type === "switch") {
    const inputType = (sourceNode.data as { inputType?: string | null } | undefined)?.inputType;
    if (inputType && targetType) return inputType === targetType;
    return true; // not resolved yet
  }

  if (targetNode?.type === "conditionalSwitch") return sourceType === "text";
  if (sourceNode?.type === "conditionalSwitch") return targetType === "text";

  // Unknown types: allow, and let the run surface any mismatch.
  if (!sourceType || !targetType) return true;

  if (targetType === "universal") return sourceType !== "text";
  if (sourceType === "universal") return true;

  if (sourceType === "easeCurve" || targetType === "easeCurve") {
    if (targetNode?.type === "router" || sourceNode?.type === "router") return true;
    if (sourceType !== "easeCurve" || targetType !== "easeCurve") return false;
    return targetNode?.type === "easeCurve";
  }

  if (sourceType === "video") {
    if (!targetNode) return false;
    // A handle that says it takes video takes video. This is the fix: it is the
    // ordinary type match, and without it any node that grows a video pin —
    // llmGenerate did — is refused however correct its pin is.
    if (targetType === "video") return true;
    if (VIDEO_TARGET_NODE_TYPES.has(targetNode.type ?? "")) return true;
    if (SCHEMA_DRIVEN_VIDEO_TARGETS.has(targetNode.type ?? "")) {
      return schemaHasType(targetNode, "video");
    }
    return false;
  }

  if (sourceType === "audio") {
    if (!targetNode) return false;
    if (targetType === "audio") return true;
    const t = targetNode.type ?? "";
    if (t === "output" || t === "router" || t === "generateAudio") return true;
    if (SCHEMA_DRIVEN_AUDIO_TARGETS.has(t)) return schemaHasType(targetNode, "audio");
    return false;
  }

  if (sourceType === "3d" || targetType === "3d") {
    if (sourceNode?.type === "router" || targetNode?.type === "router") return true;
    if (sourceType === "3d" && targetNode?.type === "output") return true;
    return sourceType === "3d" && targetType === "3d";
  }

  // image → image, text → text.
  return sourceType === targetType;
}
