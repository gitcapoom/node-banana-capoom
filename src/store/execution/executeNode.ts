/**
 * Central node dispatcher.
 *
 * Maps a node's type to the correct executor function, eliminating the
 * duplicated switch/if-else chains that previously existed in
 * executeWorkflow, regenerateNode, and executeSelectedNodes.
 */

import type { NodeExecutionContext } from "./types";
import type { WorkflowNode } from "@/types";
import {
  executeAnnotation,
  executeArray,
  executeMaskPainter,
  executeRoto,
  executeComp,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeVideoCompare,
  executeGlbViewer,
  executeSpzViewer,
  executeImageCrop,
  executeMirror,
  executeSphereLightRender,
  executeReformat,
  executeCubemapEquirect,
  executeCubemapFaces,
  executeColorGrade,
  executeHsvCorrect,
  executeContrastAdjust,
  executePanoShift,
} from "./simpleNodeExecutors";
import { executeNanoBanana } from "./nanoBananaExecutor";
import { executeGenerateVideo } from "./generateVideoExecutor";
import { executeGenerate3D } from "./generate3dExecutor";
import { executeImage2GS } from "./image2gsExecutor";
import { executeLlmGenerate } from "./llmGenerateExecutor";
import { executeSplitGrid } from "./splitGridExecutor";
import { executeVideoStitch, executeEaseCurve, executeVideoTrim, executeVideoFrameGrab } from "./videoProcessingExecutors";
import { executeWorldLabsPano } from "./worldLabsPanoExecutor";
import { executeWorldLabsWorld } from "./worldLabsWorldExecutor";
import { executeGenerateAudio } from "./generateAudioExecutor";

export interface ExecuteNodeOptions {
  /** When true, executors that support it will fall back to stored inputs. */
  useStoredFallback?: boolean;
}

/**
 * Execute a single node by dispatching to the appropriate executor.
 *
 * Data-source node types (`imageInput`, `audioInput`) are no-ops.
 */
export async function executeNode(
  ctx: NodeExecutionContext,
  options?: ExecuteNodeOptions,
): Promise<void> {
  const regenOpts = options?.useStoredFallback ? { useStoredFallback: true } : undefined;

  switch (ctx.node.type) {
    case "imageInput":
      // Data source node — no execution needed
      break;
    case "audioInput": {
      // If audio is connected from upstream, use it (connection wins over upload)
      const audioInputs = ctx.getConnectedInputs(ctx.node.id);
      if (audioInputs.audio.length > 0 && audioInputs.audio[0]) {
        ctx.updateNodeData(ctx.node.id, { audioFile: audioInputs.audio[0] });
      }
      break;
    }
    case "videoInput": {
      // If video is connected from upstream, use it (connection wins over upload)
      const videoInputs = ctx.getConnectedInputs(ctx.node.id);
      if (videoInputs.videos.length > 0 && videoInputs.videos[0]) {
        ctx.updateNodeData(ctx.node.id, { videoFile: videoInputs.videos[0] });
      }
      break;
    }
    case "annotation":
      await executeAnnotation(ctx);
      break;
    case "prompt":
      await executePrompt(ctx);
      break;
    case "array":
      await executeArray(ctx);
      break;
    case "promptConstructor":
      await executePromptConstructor(ctx);
      break;
    case "nanoBanana":
      await executeNanoBanana(ctx, regenOpts);
      break;
    case "generateVideo":
      await executeGenerateVideo(ctx, regenOpts);
      break;
    case "generate3d":
      await executeGenerate3D(ctx, regenOpts);
      break;
    case "image2GS":
      await executeImage2GS(ctx);
      break;
    case "llmGenerate":
      await executeLlmGenerate(ctx, regenOpts);
      break;
    case "splitGrid":
      await executeSplitGrid(ctx);
      break;
    case "output":
      await executeOutput(ctx);
      break;
    case "outputGallery":
      await executeOutputGallery(ctx);
      break;
    case "imageCompare":
      await executeImageCompare(ctx);
      break;
    case "videoCompare":
      await executeVideoCompare(ctx);
      break;
    case "videoStitch":
      await executeVideoStitch(ctx);
      break;
    case "easeCurve":
      await executeEaseCurve(ctx);
      break;
    case "videoTrim":
      await executeVideoTrim(ctx);
      break;
    case "glbViewer":
      await executeGlbViewer(ctx);
      break;
    case "spzViewer":
      await executeSpzViewer(ctx);
      break;
    case "worldLabsPano":
      await executeWorldLabsPano(ctx);
      break;
    case "worldLabsWorld":
      await executeWorldLabsWorld(ctx);
      break;
    case "maskPainter":
      await executeMaskPainter(ctx);
      break;
    case "roto":
      await executeRoto(ctx);
      break;
    case "comp":
      await executeComp(ctx);
      break;
    case "generateAudio":
      await executeGenerateAudio(ctx, regenOpts);
      break;
    case "videoFrameGrab":
      await executeVideoFrameGrab(ctx);
      break;
    case "imageCrop":
      await executeImageCrop(ctx);
      break;
    case "mirror":
      await executeMirror(ctx);
      break;
    case "sphereLightRender":
      await executeSphereLightRender(ctx);
      break;
    case "reformat":
      await executeReformat(ctx);
      break;
    case "cubemapEquirect":
      await executeCubemapEquirect(ctx);
      break;
    case "cubemapFaces":
      await executeCubemapFaces(ctx);
      break;
    case "colorGrade":
      await executeColorGrade(ctx);
      break;
    case "hsvCorrect":
      await executeHsvCorrect(ctx);
      break;
    case "contrastAdjust":
      await executeContrastAdjust(ctx);
      break;
    case "panoShift":
      await executePanoShift(ctx);
      break;
  }
}

/**
 * Node types that are cheap, LOCAL, deterministic transforms of their inputs
 * (canvas/GPU/text ops — no API calls, no cost). Safe to recompute on every
 * downstream per-node Run, so generators always read CURRENT data instead of
 * the stale output a previous run left behind (e.g. a reformat whose input
 * changed since it last executed).
 */
export const LOCAL_PROCESSOR_TYPES: ReadonlySet<string> = new Set([
  "annotation",
  "imageCrop",
  "mirror",
  "reformat",
  "cubemapEquirect",
  "cubemapFaces",
  "colorGrade",
  "hsvCorrect",
  "contrastAdjust",
  "panoShift",
  "maskPainter",
  "roto",
  "comp",
  "promptConstructor",
  "array",
  "splitGrid",
]);

/**
 * Re-execute every LOCAL processor upstream of `rootIds` (upstream-first) so a
 * per-node / selection Run reads current data. API generators upstream are NOT
 * re-run — their expensive cached outputs are kept. The roots themselves are
 * never re-run here (the caller runs them). Failures are best-effort: the
 * processor's executor records its own error state and the main run proceeds.
 */
export async function refreshUpstreamProcessors(
  rootIds: string[],
  nodes: WorkflowNode[],
  edges: Array<{ source: string; target: string }>,
  buildCtx: (node: WorkflowNode) => NodeExecutionContext,
  isLocked?: (nodeId: string) => boolean,
): Promise<void> {
  // Transitive upstream closure of all roots.
  const roots = new Set(rootIds);
  const closure = new Set<string>();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const e of edges) {
      if (e.target === cur && !closure.has(e.source)) {
        closure.add(e.source);
        queue.push(e.source);
      }
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isTarget = (id: string): boolean => {
    if (roots.has(id)) return false;
    if (isLocked?.(id)) return false;
    const t = byId.get(id)?.type;
    return !!t && LOCAL_PROCESSOR_TYPES.has(t);
  };
  if (![...closure].some(isTarget)) return;

  // Upstream-first order: Kahn over the whole closure (a processor can depend
  // on another through intermediate non-processor nodes), then filtered.
  const indeg = new Map<string, number>();
  for (const id of closure) indeg.set(id, 0);
  for (const e of edges) {
    if (closure.has(e.source) && closure.has(e.target)) {
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    }
  }
  const ready = [...closure].filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of edges) {
      if (e.source === id && closure.has(e.target)) {
        const d = (indeg.get(e.target) ?? 0) - 1;
        indeg.set(e.target, d);
        if (d === 0) ready.push(e.target);
      }
    }
  }

  for (const id of order) {
    if (!isTarget(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    try {
      await executeNode(buildCtx(node), { useStoredFallback: true });
    } catch (err) {
      console.warn(`[refreshUpstreamProcessors] ${node.type} ${id} failed:`, err);
    }
  }
}
