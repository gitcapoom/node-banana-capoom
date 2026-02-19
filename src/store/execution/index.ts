/**
 * Node Executor Registry
 *
 * Maps node types to their executor functions.
 * Used by executeWorkflow and regenerateNode to eliminate
 * duplicated switch/if-else chains.
 */

export type { NodeExecutionContext, NodeExecutor } from "./types";

export {
  executeAnnotation,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeGlbViewer,
  executeSpzViewer,
} from "./simpleNodeExecutors";

export { executeNanoBanana } from "./nanoBananaExecutor";
export type { NanoBananaOptions } from "./nanoBananaExecutor";

export { executeGenerateVideo } from "./generateVideoExecutor";
export type { GenerateVideoOptions } from "./generateVideoExecutor";

export { executeGenerate3D } from "./generate3dExecutor";
export type { Generate3DOptions } from "./generate3dExecutor";

export { executeLlmGenerate } from "./llmGenerateExecutor";
export type { LlmGenerateOptions } from "./llmGenerateExecutor";

export { executeSplitGrid } from "./splitGridExecutor";

export {
  executeVideoStitch,
  executeEaseCurve,
} from "./videoProcessingExecutors";

export { executeWorldLabsPano } from "./worldLabsPanoExecutor";
export { executeWorldLabsWorld } from "./worldLabsWorldExecutor";
