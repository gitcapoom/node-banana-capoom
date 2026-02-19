/**
 * Central node dispatcher.
 *
 * Maps a node's type to the correct executor function, eliminating the
 * duplicated switch/if-else chains that previously existed in
 * executeWorkflow, regenerateNode, and executeSelectedNodes.
 */

import type { NodeExecutionContext } from "./types";
import {
  executeAnnotation,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeGlbViewer,
  executeSpzViewer,
} from "./simpleNodeExecutors";
import { executeNanoBanana } from "./nanoBananaExecutor";
import { executeGenerateVideo } from "./generateVideoExecutor";
import { executeGenerate3D } from "./generate3dExecutor";
import { executeLlmGenerate } from "./llmGenerateExecutor";
import { executeSplitGrid } from "./splitGridExecutor";
import { executeVideoStitch, executeEaseCurve } from "./videoProcessingExecutors";
import { executeWorldLabsPano } from "./worldLabsPanoExecutor";
import { executeWorldLabsWorld } from "./worldLabsWorldExecutor";

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
    case "audioInput":
      // Data source nodes — no execution needed
      break;
    case "annotation":
      await executeAnnotation(ctx);
      break;
    case "prompt":
      await executePrompt(ctx);
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
    case "videoStitch":
      await executeVideoStitch(ctx);
      break;
    case "easeCurve":
      await executeEaseCurve(ctx);
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
  }
}
