import { create, StateCreator } from "zustand";
import { useShallow } from "zustand/shallow";
import {
  Connection,
  EdgeChange,
  NodeChange,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  XYPosition,
} from "@xyflow/react";
import {
  WorkflowNode,
  WorkflowEdge,
  NodeType,
  NanoBananaNodeData,
  Generate3DNodeData,
  GLBViewerNodeData,
  OutputGalleryNodeData,
  WorkflowNodeData,
  ImageHistoryItem,
  NodeGroup,
  GroupColor,
  ProviderType,
  ProviderSettings,
  RecentModel,
  CanvasNavigationSettings,
  MatchMode,
  MODEL_DISPLAY_NAMES,
} from "@/types";
import { useToast } from "@/components/Toast";
import { logger } from "@/utils/logger";
import { externalizeWorkflowImages, hydrateWorkflowImages } from "@/utils/imageStorage";
import { relocalizeNodeImageRefs } from "@/utils/mediaStorage";
import { EditOperation, applyEditOperations as executeEditOps } from "@/lib/chat/editOperations";
import {
  loadSaveConfigs,
  saveSaveConfig,
  loadWorkflowCostData,
  saveWorkflowCostData,
  getProviderSettings,
  saveProviderSettings,
  defaultProviderSettings,
  getRecentModels,
  saveRecentModels,
  MAX_RECENT_MODELS,
  generateWorkflowId,
  getCanvasNavigationSettings,
  saveCanvasNavigationSettings,
} from "./utils/localStorage";
import {
  createDefaultNodeData,
  defaultNodeDimensions,
  GROUP_COLORS,
  GROUP_COLOR_ORDER,
} from "./utils/nodeDefaults";
import {
  CONCURRENCY_SETTINGS_KEY,
  loadConcurrencySetting,
  saveConcurrencySetting,
  groupNodesByLevel,
  chunk,
  clearNodeImageRefs,
} from "./utils/executionUtils";
import { getConnectedInputsPure, validateWorkflowPure } from "./utils/connectedInputs";
import { migrateEdgeHandles, conformEdgesToRenderablePins, DYNAMIC_PIN_NODE_TYPES } from "./utils/pinMigration";

import { getDynamicPinsEnabled } from "@/lib/dynamicPins";
import { isDynPin } from "@/lib/dynamicPinId";
import { ensureFullResForNodes } from "./execution/hydrateForRun";
import { refreshUpstreamProcessors, refreshDownstreamProcessors } from "./execution/executeNode";
import { evaluateRule } from "./utils/ruleEvaluation";
import { computeDimmedNodes } from "./utils/dimmingUtils";
import { getRunBlocker } from "./utils/runGating";
import {
  executeAnnotation,
  executeArray,
  executeMaskPainter,
  executeSphereLightRender,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeVideoCompare,
  executeNanoBanana,
  executeGenerateVideo,
  executeGenerate3D,
  executeImage2GS,
  executeGenerateAudio,
  executeLlmGenerate,
  executeSplitGrid,
  executeUpscaleGrid,
  executeVideoStitch,
  executeEaseCurve,
  executeVideoTrim,
  executeVideoFrameGrab,
  executeGlbViewer,
  executeSpzViewer,
  executeWorldLabsPano,
  executeWorldLabsWorld,
  executePanoViewer,
  executePanoEditor,
  executeRouter,
  executeSwitch,
  executeConditionalSwitch,
} from "./execution";
import type { NodeExecutionContext } from "./execution";
export type { LevelGroup } from "./utils/executionUtils";
export { CONCURRENCY_SETTINGS_KEY } from "./utils/executionUtils";

/**
 * Strip generation outputs from node data when pasting, keeping settings intact.
 * Generation nodes should paste clean (no outputs/history) but with all their
 * configuration (model, parameters, prompts, etc.) preserved.
 */
function stripGenerationOutputs(nodeType: string, data: Record<string, unknown>): Record<string, unknown> {
  switch (nodeType) {
    case "nanoBanana":
      return {
        ...data,
        inputImages: [],
        inputImageRefs: undefined,
        inputPrompt: null,
        outputImage: null,
        outputImageRef: undefined,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
        lastGenerationCost: null,
      };
    case "generateVideo":
      return {
        ...data,
        inputImages: [],
        inputImageRefs: undefined,
        inputPrompt: null,
        outputVideo: null,
        outputVideoRef: undefined,
        thumbnailImage: null,
        thumbnailImageRef: undefined,
        status: "idle",
        error: null,
        videoHistory: [],
        selectedVideoHistoryIndex: 0,
        lastGenerationCost: null,
      };
    case "generate3d":
      return {
        ...data,
        inputImages: [],
        inputImageRefs: undefined,
        inputPrompt: null,
        output3dUrl: null,
        savedFilename: null,
        savedFilePath: null,
        thumbnailImage: null,
        thumbnailImageRef: undefined,
        status: "idle",
        error: null,
        model3dHistory: [],
        selectedModel3dHistoryIndex: 0,
        lastGenerationCost: null,
      };
    case "generateAudio":
      return {
        ...data,
        inputPrompt: null,
        outputAudio: null,
        outputAudioRef: undefined,
        status: "idle",
        error: null,
        audioHistory: [],
        selectedAudioHistoryIndex: 0,
        duration: null,
        format: null,
        lastGenerationCost: null,
      };
    case "llmGenerate":
      return {
        ...data,
        // A generous default output cap — maxTokens is a ceiling, not a fixed
        // cost, so this only prevents truncation (e.g. loopback assessment +
        // <image_prompt> block) without adding cost for normal replies.
        maxTokens: (data as { maxTokens?: number }).maxTokens ?? 8192,
        inputPrompt: null,
        inputImages: [],
        inputImageRefs: undefined,
        outputText: null,
        status: "idle",
        error: null,
        lastGenerationCost: null,
      };
    case "worldLabsPano":
      return {
        ...data,
        inputImages: [],
        inputPrompt: null,
        operationId: null,
        worldId: null,
        status: "idle",
        error: null,
        progress: null,
        panoUrl: null,
        thumbnailUrl: null,
        caption: null,
      };
    case "worldLabsWorld":
      return {
        ...data,
        inputImages: [],
        inputPrompt: null,
        operationId: null,
        worldId: null,
        status: "idle",
        error: null,
        progress: null,
        spzUrls: null,
        panoUrl: null,
        thumbnailUrl: null,
        marbleViewerUrl: null,
        caption: null,
        viewerWindowOpen: false,
      };
    default:
      return data;
  }
}

/**
 * Evaluate conditional switch rules against incoming text, update node data, then execute.
 */
async function evaluateAndExecuteConditionalSwitch(
  node: WorkflowNode,
  executionCtx: NodeExecutionContext,
  getConnectedInputs: (nodeId: string) => { text: string | null; images: string[]; videos: string[]; audio: string[]; model3d: string | null; dynamicInputs: Record<string, string | string[]>; easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null; outputDuration: number } | null },
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void,
): Promise<void> {
  const condInputs = getConnectedInputs(node.id);
  const incomingText = condInputs.text;
  const nodeData = node.data as { rules: Array<{ id: string; value: string; mode: string; label: string; isMatched: boolean }> };

  const updatedRules = nodeData.rules.map(rule => {
    const isMatched = evaluateRule(incomingText, rule.value, rule.mode as MatchMode);
    return { ...rule, isMatched };
  });

  updateNodeData(node.id, {
    incomingText,
    rules: updatedRules,
    evaluationPaused: false,
  });

  await executeConditionalSwitch(executionCtx);
}

function saveLogSession(): void {
  try {
    const session = logger.getCurrentSession();
    if (session) {
      session.endTime = new Date().toISOString();
      fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session }),
      }).catch((err) => {
        console.error('Failed to save log session:', err);
      });
    }
  } catch (err) {
    console.error('Failed to serialize log session:', err);
  }
}

export type EdgeStyle = "angular" | "curved";

function buildConnectionEdgeData(
  connection: Connection,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): Record<string, unknown> {
  const baseData: Record<string, unknown> = { createdAt: Date.now() };
  const sourceNode = nodes.find((n) => n.id === connection.source);

  // Array node uses a single output handle; assign each edge a stable item index.
  if (sourceNode?.type === "array" && (connection.sourceHandle || "text") === "text") {
    const sourceData = sourceNode.data as Record<string, unknown>;
    const selectedIndex = sourceData.selectedOutputIndex;
    const outputItems = Array.isArray(sourceData.outputItems) ? sourceData.outputItems : [];
    const outputCount = outputItems.length;

    if (
      typeof selectedIndex === "number" &&
      Number.isInteger(selectedIndex) &&
      selectedIndex >= 0 &&
      (outputCount === 0 || selectedIndex < outputCount)
    ) {
      baseData.arrayItemIndex = selectedIndex;
      return baseData;
    }

    if (outputCount > 0) {
      const existingArrayEdges = edges.filter(
        (e) => e.source === connection.source && (e.sourceHandle || "text") === "text"
      );

      const lastEdge = existingArrayEdges.reduce<WorkflowEdge | null>((latest, edge) => {
        if (!latest) return edge;
        const latestTime = (latest.data as Record<string, unknown> | undefined)?.createdAt;
        const edgeTime = (edge.data as Record<string, unknown> | undefined)?.createdAt;
        return (typeof edgeTime === "number" && typeof latestTime === "number" && edgeTime > latestTime) ? edge : latest;
      }, null);

      const lastIndex = (lastEdge?.data as Record<string, unknown> | undefined)?.arrayItemIndex;
      const startIndex = typeof lastIndex === "number" && Number.isInteger(lastIndex) && lastIndex >= 0
        ? lastIndex + 1
        : existingArrayEdges.length;

      baseData.arrayItemIndex = startIndex % outputCount;
    } else {
      baseData.arrayItemIndex = 0;
    }
  }

  return baseData;
}

// Workflow file format
export interface WorkflowFile {
  version: 1;
  id?: string;  // Optional for backward compatibility with old/shared workflows
  name: string;
  directoryPath?: string;  // Embedded save path so image hydration works on import
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeStyle: EdgeStyle;
  groups?: Record<string, NodeGroup>;  // Optional for backward compatibility
  embedded?: boolean;  // true = sidecar workflow with base64-embedded images (import, don't replace)
}

// Clipboard data structure for copy/paste
interface ClipboardData {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  // Project the nodes were copied FROM — so paste into a different project can
  // re-localize image refs (copy the referenced files into the new project).
  sourceDirectoryPath?: string | null;
}

// Snapshot for undo/redo history
interface WorkflowSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  edgeStyle: EdgeStyle;
}

const UNDO_STACK_MAX = 15;
const UNDO_DEBOUNCE_MS = 500;

/** Fields to KEEP in undo snapshots — only small, user-editable data */
const UNDO_KEEP_FIELDS = new Set([
  // Core identity
  "type", "label", "comment",
  // Model selection
  "model", "selectedModel", "provider",
  // Prompts (usually <5KB)
  "inputPrompt", "negativePrompt", "prompt",
  // Settings (small values)
  "aspectRatio", "resolution", "parameters", "parametersExpanded",
  "useGoogleSearch", "useImageSearch", "quality",
  // Status (for display, tiny)
  "status", "error",
  // Selection indices (numbers)
  "selectedHistoryIndex", "selectedVideoHistoryIndex", "selectedModel3dHistoryIndex", "selectedAudioHistoryIndex",
  // Node-specific small fields
  "text", "filename", "spzUrl", "worldId", "worldName", "url",
  "switches", "rules", "evaluationPaused", "matchMode",
  "inputType", "viewerOpen", "viewerWindowOpen",
  "sensorIndex", "lensIndex", "aspectIndex",
  "duration", "seed",
]);

/** Create a minimal snapshot of a node — only positions + small data fields */
function snapshotNode(node: WorkflowNode): WorkflowNode {
  const d = node.data as Record<string, unknown>;
  const minimal: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (UNDO_KEEP_FIELDS.has(k)) {
      minimal[k] = v;
    }
  }
  return {
    id: node.id,
    type: node.type,
    position: { ...node.position },
    data: minimal as WorkflowNodeData,
    ...(node.style ? { style: { ...node.style } } : {}),
    ...(node.groupId !== undefined ? { groupId: node.groupId } : {}),
  } as WorkflowNode;
}

/**
 * Cache of full node data for recently deleted nodes.
 * When a node is removed, its complete data is saved here so undo can restore it fully.
 * Bounded: only holds nodes deleted since the oldest undo stack entry.
 */
const deletedNodesCache = new Map<string, WorkflowNode>();

/** Merge snapshot back with current live nodes. Snapshot fields overwrite,
 *  all other fields (images, history, etc.) are kept from current state. */
function mergeSnapshotWithLive(snapshotNodes: WorkflowNode[], currentNodes: WorkflowNode[]): WorkflowNode[] {
  const currentMap = new Map(currentNodes.map(n => [n.id, n]));
  return snapshotNodes.map(sNode => {
    const cNode = currentMap.get(sNode.id) || deletedNodesCache.get(sNode.id);
    if (!cNode) {
      // Node not in current state or cache — restore with only snapshot data
      return sNode;
    }
    // Start with current node (has all live data: images, history, etc.)
    // Overwrite with snapshot fields (position, settings, prompts)
    return {
      ...cNode,
      position: sNode.position,
      style: sNode.style ?? cNode.style,
      groupId: (sNode as WorkflowNode & { groupId?: string }).groupId,
      data: {
        ...(cNode.data as Record<string, unknown>),
        ...(sNode.data as Record<string, unknown>),
      } as WorkflowNodeData,
    } as WorkflowNode;
  });
}

interface WorkflowStore {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeStyle: EdgeStyle;
  clipboard: ClipboardData | null;
  groups: Record<string, NodeGroup>;

  // Settings
  setEdgeStyle: (style: EdgeStyle) => void;

  // Node operations
  addNode: (type: NodeType, position: XYPosition, initialData?: Partial<WorkflowNodeData>) => string;
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
  removeNode: (nodeId: string) => void;
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void;

  // Edge operations
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
  onConnect: (connection: Connection, edgeDataOverrides?: Record<string, unknown>) => void;
  addEdgeWithType: (connection: Connection, edgeType: string, edgeDataOverrides?: Record<string, unknown>) => void;
  removeEdge: (edgeId: string) => void;
  toggleEdgePause: (edgeId: string) => void;

  // Copy/Paste operations
  copySelectedNodes: () => void;
  pasteNodes: (offset?: XYPosition) => void;
  pasteNodesWithInputs: (offset?: XYPosition) => void;
  clearClipboard: () => void;

  // Group operations
  createGroup: (nodeIds: string[]) => string;
  deleteGroup: (groupId: string) => void;
  addNodesToGroup: (nodeIds: string[], groupId: string) => void;
  removeNodesFromGroup: (nodeIds: string[]) => void;
  updateGroup: (groupId: string, updates: Partial<NodeGroup>) => void;
  toggleGroupLock: (groupId: string) => void;
  moveGroupNodes: (groupId: string, delta: { x: number; y: number }) => void;
  setNodeGroupId: (nodeId: string, groupId: string | undefined) => void;

  // UI State
  openModalCount: number;
  isModalOpen: boolean;
  showQuickstart: boolean;
  hoveredNodeId: string | null;
  incrementModalCount: () => void;
  decrementModalCount: () => void;
  setShowQuickstart: (show: boolean) => void;
  setHoveredNodeId: (id: string | null) => void;

  // Execution
  isRunning: boolean;
  currentNodeIds: string[];  // Changed from currentNodeId for parallel execution
  pausedAtNodeId: string | null;
  maxConcurrentCalls: number;  // Configurable concurrency limit (1-10)
  _abortController: AbortController | null;  // Internal: for cancellation
  _buildExecutionContext: (node: WorkflowNode, signal?: AbortSignal) => NodeExecutionContext;
  executeWorkflow: (startFromNodeId?: string) => Promise<void>;
  regenerateNode: (nodeId: string) => Promise<void>;
  /** Load full-res for a node + its upstream from disk (lazy on open). Used by
   *  GPU editors (color / comp) to populate the live preview on double-click. */
  loadNodeFullResInputs: (nodeId: string) => Promise<void>;
  /** Re-run cheap local processors downstream of a node — used by the live
   *  editors so their output propagates whether or not those nodes are
   *  currently mounted on the canvas. */
  propagateFromNode: (nodeId: string) => Promise<void>;
  executeSelectedNodes: (nodeIds: string[]) => Promise<void>;
  stopWorkflow: () => void;
  setMaxConcurrentCalls: (value: number) => void;

  // Save/Load
  saveWorkflow: (name?: string) => void;
  loadWorkflow: (workflow: WorkflowFile, workflowPath?: string, options?: { preserveSnapshot?: boolean }) => Promise<void>;
  /** Remap edge handles between the classic and dynamic-pin schemes when the flag toggles. */
  migratePinMode: (enabled: boolean) => void;
  importWorkflow: (workflow: WorkflowFile, dropPosition?: { x: number; y: number }) => void;
  clearWorkflow: () => void;

  // Helpers
  getNodeById: (id: string) => WorkflowNode | undefined;
  getConnectedInputs: (nodeId: string) => { images: string[]; videos: string[]; audio: string[]; model3d: string | null; text: string | null; dynamicInputs: Record<string, string | string[]>; easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null; outputDuration: number } | null };
  validateWorkflow: () => { valid: boolean; errors: string[] };

  // Global Image History
  globalImageHistory: ImageHistoryItem[];
  addToGlobalHistory: (item: Omit<ImageHistoryItem, "id">) => void;
  clearGlobalHistory: () => void;

  // Auto-save state
  workflowId: string | null;
  workflowName: string | null;
  saveDirectoryPath: string | null;
  generationsPath: string | null;
  lastSavedAt: number | null;
  hasUnsavedChanges: boolean;
  autoSaveEnabled: boolean;
  isSaving: boolean;
  useExternalImageStorage: boolean;  // Store images as separate files vs embedded base64
  imageRefBasePath: string | null;  // Directory from which current imageRefs are valid

  // Auto-save actions
  setWorkflowMetadata: (id: string, name: string, path: string, generationsPath?: string | null) => void;
  setWorkflowName: (name: string) => void;
  setGenerationsPath: (path: string | null) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;
  setUseExternalImageStorage: (enabled: boolean) => void;
  markAsUnsaved: () => void;
  /** `allowEmpty` marks a save the USER asked for: only those may write an
   *  empty graph over an existing workflow (the server refuses otherwise). */
  saveToFile: (opts?: { allowEmpty?: boolean }) => Promise<boolean>;
  saveAsFile: (name: string) => Promise<boolean>;
  initializeAutoSave: () => void;
  cleanupAutoSave: () => void;

  // Cost tracking state
  incurredCost: number;

  // Cost tracking actions
  addIncurredCost: (cost: number) => void;
  resetIncurredCost: () => void;
  loadIncurredCost: (workflowId: string) => void;
  saveIncurredCost: () => void;

  // Provider settings state
  providerSettings: ProviderSettings;

  // Provider settings actions
  updateProviderSettings: (settings: ProviderSettings) => void;
  updateProviderApiKey: (providerId: ProviderType, apiKey: string | null) => void;
  toggleProvider: (providerId: ProviderType, enabled: boolean) => void;

  // Model search dialog state
  modelSearchOpen: boolean;
  modelSearchProvider: ProviderType | null;

  // Keyboard shortcuts dialog state
  shortcutsDialogOpen: boolean;
  setShortcutsDialogOpen: (open: boolean) => void;

  // Model search dialog actions
  setModelSearchOpen: (open: boolean, provider?: ProviderType | null) => void;

  // Recent models state
  recentModels: RecentModel[];

  // Recent models actions
  trackModelUsage: (model: { provider: ProviderType; modelId: string; displayName: string }) => void;

  // Comment navigation state
  viewedCommentNodeIds: Set<string>;
  navigationTarget: { nodeId: string; timestamp: number } | null;
  focusedCommentNodeId: string | null;

  // Comment navigation actions
  getNodesWithComments: () => WorkflowNode[];
  getUnviewedCommentCount: () => number;
  markCommentViewed: (nodeId: string) => void;
  setNavigationTarget: (nodeId: string | null) => void;
  setFocusedCommentNodeId: (nodeId: string | null) => void;
  resetViewedComments: () => void;

  // AI change snapshot state
  previousWorkflowSnapshot: {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    groups: Record<string, NodeGroup>;
    edgeStyle: EdgeStyle;
  } | null;
  manualChangeCount: number;

  // AI change snapshot actions
  captureSnapshot: () => void;
  revertToSnapshot: () => void;
  clearSnapshot: () => void;
  incrementManualChangeCount: () => void;

  // Undo/Redo state
  undoStack: WorkflowSnapshot[];
  redoStack: WorkflowSnapshot[];
  _lastSnapshotTime: number;

  // Undo/Redo actions
  pushUndoSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  applyEditOperations: (operations: EditOperation[]) => { applied: number; skipped: string[] };

  // Canvas navigation settings state
  canvasNavigationSettings: CanvasNavigationSettings;

  // Canvas navigation settings actions
  updateCanvasNavigationSettings: (settings: CanvasNavigationSettings) => void;

  // Switch dimming state
  dimmedNodeIds: Set<string>;

  // Switch dimming actions
  recomputeDimmedNodes: () => void;

}

let nodeIdCounter = 0;
let groupIdCounter = 0;
let autoSaveIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * How often autosave fires. Was 90s, which on this project's graphs meant a
 * full externalize-and-write pass (walking every node, hashing and writing any
 * new images) three times a minute — enough to be felt while working, and a
 * narrow window in which a bad state could be persisted twice and take the
 * rolling .bak with it. Five minutes keeps the safety net without the churn;
 * Ctrl+S is still there for anything you don't want to lose.
 */
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;

// RAF debounce for hover updates — coalesces rapid mouseenter/mouseleave events
// into a single store update per animation frame
let hoverRafId: number | null = null;

// Track pending save-generation syncs to ensure IDs are resolved before workflow save
const pendingImageSyncs = new Map<string, Promise<void>>();

// Wait for all pending image syncs to complete (with timeout to prevent infinite hangs)
async function waitForPendingImageSyncs(timeout: number = 60000): Promise<void> {
  if (pendingImageSyncs.size === 0) return;

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`Pending image syncs timed out after ${timeout}ms, continuing with save`);
      resolve();
    }, timeout);
  });

  try {
    await Promise.race([
      Promise.all(pendingImageSyncs.values()),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}


// Re-export for backward compatibility
export { generateWorkflowId, saveGenerateImageDefaults, saveNanoBananaDefaults } from "./utils/localStorage";
export { GROUP_COLORS } from "./utils/nodeDefaults";

/** Node types whose output carries image data */
const IMAGE_SOURCE_NODE_TYPES = new Set<string>([
  "imageInput", "annotation", "nanoBanana", "glbViewer", "videoFrameGrab",
]);

/**
 * After edges are removed, clear inputImages on any target node that no longer
 * has an image-source edge. Prevents stale images from being sent to the API
 * when useStoredFallback picks up old node data.
 */
function clearStaleInputImages(
  removedEdges: WorkflowEdge[],
  get: () => WorkflowStore
): void {
  if (removedEdges.length === 0) return;
  const { edges, nodes, updateNodeData } = get();
  const targetIds = new Set(removedEdges.map((e) => e.target));
  for (const targetId of targetIds) {
    const node = nodes.find((n) => n.id === targetId);
    if (!node || !("inputImages" in (node.data as Record<string, unknown>))) continue;
    const hasRemainingImageSource = edges.some((e) => {
      if (e.target !== targetId) return false;
      const src = nodes.find((n) => n.id === e.source);
      return src ? IMAGE_SOURCE_NODE_TYPES.has(src.type ?? "") : false;
    });
    if (!hasRemainingImageSource) {
      updateNodeData(targetId, { inputImages: [] });
    }
  }
}

// Node types whose components render the first schema input of a type as the
// bare handle ("image"/"text"; extras are "image-1"+, never "image-0"/"text-0").
// Edges saved with the old indexed-from-0 format cause React Flow error #008.
// Scoped by target type: panoEditor legitimately renders a static "image-0".
const BARE_FIRST_HANDLE_NODE_TYPES = new Set(["nanoBanana", "generateVideo", "generate3d", "upscaleGrid"]);

function migrateLegacyIndexedHandles(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const targetIds = new Set(
    nodes.filter((n) => BARE_FIRST_HANDLE_NODE_TYPES.has(n.type as string)).map((n) => n.id)
  );
  return edges.map((edge) => {
    if (!targetIds.has(edge.target)) return edge;
    const th = edge.targetHandle;
    if (th === "image-0" || th === "text-0") {
      const baseHandle = th === "image-0" ? "image" : "text";
      return {
        ...edge,
        targetHandle: baseHandle,
        id: `edge-${edge.source}-${edge.target}-${edge.sourceHandle || "default"}-${baseHandle}`,
      };
    }
    return edge;
  });
}

/**
 * Delete or retarget ghost edges on dynamic-pin nodes — leftovers from
 * rewires/model switches that anchor to no rendered handle (the React Flow
 * #008 console spam) and, worse, kept feeding STALE data into resolution.
 * One rule set for every node type: conformEdgesToRenderablePins.
 */
function sweepGhostEdges(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  if (!getDynamicPinsEnabled()) return edges;
  let out = edges;
  for (const n of nodes) {
    if (!DYNAMIC_PIN_NODE_TYPES.has(n.type as string)) continue;
    out = conformEdgesToRenderablePins(n, out) ?? out;
  }
  return out;
}

const workflowStoreImpl: StateCreator<WorkflowStore> = (set, get) => ({
  nodes: [],
  edges: [],
  edgeStyle: "curved" as EdgeStyle,
  clipboard: null,
  groups: {},
  openModalCount: 0,
  isModalOpen: false,
  showQuickstart: true,
  hoveredNodeId: null,
  isRunning: false,
  currentNodeIds: [],  // Changed from currentNodeId for parallel execution
  pausedAtNodeId: null,
  maxConcurrentCalls: loadConcurrencySetting(),  // Default 3, configurable 1-10
  _abortController: null,  // Internal: for cancellation
  globalImageHistory: [],

  // Auto-save initial state
  workflowId: null,
  workflowName: null,
  saveDirectoryPath: null,
  generationsPath: null,
  lastSavedAt: null,
  hasUnsavedChanges: false,
  autoSaveEnabled: true,
  isSaving: false,
  useExternalImageStorage: true,  // Default: store images as separate files
  imageRefBasePath: null,  // Directory from which current imageRefs are valid

  // Cost tracking initial state
  incurredCost: 0,

  // Provider settings initial state
  providerSettings: getProviderSettings(),

  // Model search dialog initial state
  modelSearchOpen: false,
  modelSearchProvider: null,

  // Keyboard shortcuts dialog initial state
  shortcutsDialogOpen: false,

  // Recent models initial state
  recentModels: getRecentModels(),

  // Comment navigation initial state
  viewedCommentNodeIds: new Set<string>(),
  navigationTarget: null,
  focusedCommentNodeId: null,

  // AI change snapshot initial state
  previousWorkflowSnapshot: null,
  manualChangeCount: 0,

  // Undo/Redo initial state
  undoStack: [],
  redoStack: [],
  _lastSnapshotTime: 0,

  // Canvas navigation settings initial state
  canvasNavigationSettings: getCanvasNavigationSettings(),

  // Switch dimming initial state
  dimmedNodeIds: new Set<string>(),

  setEdgeStyle: (style: EdgeStyle) => {
    set({ edgeStyle: style });
  },

  incrementModalCount: () => {
    set((state) => {
      const newCount = state.openModalCount + 1;
      return { openModalCount: newCount, isModalOpen: newCount > 0 };
    });
  },

  decrementModalCount: () => {
    set((state) => {
      const newCount = Math.max(0, state.openModalCount - 1);
      return { openModalCount: newCount, isModalOpen: newCount > 0 };
    });
  },

  setShowQuickstart: (show: boolean) => {
    set({ showQuickstart: show });
  },

  setHoveredNodeId: (id: string | null) => {
    if (hoverRafId !== null) cancelAnimationFrame(hoverRafId);
    hoverRafId = requestAnimationFrame(() => {
      hoverRafId = null;
      if (get().hoveredNodeId !== id) set({ hoveredNodeId: id });
    });
  },

  addNode: (type: NodeType, position: XYPosition, initialData?: Partial<WorkflowNodeData>) => {
    get().pushUndoSnapshot();
    const id = `${type}-${++nodeIdCounter}`;

    const { width, height } = defaultNodeDimensions[type];

    // Merge default data with initialData if provided
    const defaultData = createDefaultNodeData(type);
    const nodeData = initialData
      ? ({ ...defaultData, ...initialData } as WorkflowNodeData)
      : defaultData;

    const newNode: WorkflowNode = {
      id,
      type,
      position,
      data: nodeData,
      style: { width, height },
    };

    set((state) => ({
      nodes: [...state.nodes, newNode],
      hasUnsavedChanges: true,
    }));

    get().incrementManualChangeCount();

    return id;
  },

  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => {
    // Only snapshot for user-initiated data changes, not generation outputs/status
    const skipUndoKeys = new Set(["status", "error", "outputImage", "outputImageRef", "outputVideo", "outputVideoRef", "output3dUrl", "outputAudio", "imageHistory", "videoHistory", "model3dHistory", "audioHistory", "selectedHistoryIndex", "thumbnailImage", "viewerOpen", "viewerWindowOpen", "isProcessing"]);
    const isUserChange = Object.keys(data).some(k => !skipUndoKeys.has(k));
    if (isUserChange) get().pushUndoSnapshot();
    const node = get().nodes.find((n) => n.id === nodeId);
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } as WorkflowNodeData }
          : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
    // Recompute dimming if this is a switch or conditionalSwitch node and their control data changed
    if (node?.type === "switch" && "switches" in data) {
      get().recomputeDimmedNodes();
    }
    if (node?.type === "conditionalSwitch" && ("rules" in data || "evaluationPaused" in data)) {
      get().recomputeDimmedNodes();
    }
    // Model switch: the node's inputSchema changed → remap its dyn-pin edges
    // to the new schema's fields (or drop incompatible ones). Otherwise the
    // old edges go invisible (their pins no longer render) while still
    // feeding stale fields into the request body.
    if (
      "inputSchema" in data &&
      node &&
      DYNAMIC_PIN_NODE_TYPES.has(node.type as string) &&
      getDynamicPinsEnabled()
    ) {
      const freshNode = get().nodes.find((n) => n.id === nodeId);
      if (freshNode) {
        const conformed = conformEdgesToRenderablePins(freshNode, get().edges);
        if (conformed) set({ edges: conformed });
      }
    }
  },

  removeNode: (nodeId: string) => {
    // Cache full node data before deletion so undo can restore it
    const nodeToDelete = get().nodes.find(n => n.id === nodeId);
    if (nodeToDelete) deletedNodesCache.set(nodeId, nodeToDelete);
    get().pushUndoSnapshot();
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      edges: state.edges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId
      ),
      hasUnsavedChanges: true,
    }));
    get().incrementManualChangeCount();
  },

  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some(
      (c) => c.type !== "select" && c.type !== "dimensions"
    );
    // Track manual changes only for remove operations (not position/selection/dimensions)
    const hasRemoveChange = changes.some((c) => c.type === "remove");

    // Cache full data of nodes being deleted (for undo restore)
    if (hasRemoveChange) {
      const removeIds = new Set(changes.filter(c => c.type === "remove").map(c => c.id));
      for (const node of get().nodes) {
        if (removeIds.has(node.id)) deletedNodesCache.set(node.id, node);
      }
    }

    // Snapshot for meaningful changes (position moves, removes)
    if (hasMeaningfulChange) get().pushUndoSnapshot();

    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));

    if (hasRemoveChange) {
      get().incrementManualChangeCount();
    }
  },

  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => {
    // Only mark as unsaved for meaningful changes (not selection changes)
    const hasMeaningfulChange = changes.some((c) => c.type !== "select");
    if (hasMeaningfulChange) get().pushUndoSnapshot();
    // Track manual changes only for remove operations (not selection)
    const hasRemoveChange = changes.some((c) => c.type === "remove");
    const hasAddOrRemove = changes.some((c) => c.type === "add" || c.type === "remove");

    // Capture removed edges before applyEdgeChanges removes them
    let removedEdges: WorkflowEdge[] = [];
    if (hasRemoveChange) {
      const removeIds = new Set(
        changes.filter((c) => c.type === "remove").map((c) => c.id)
      );
      removedEdges = get().edges.filter((e) => removeIds.has(e.id));
    }

    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      ...(hasMeaningfulChange ? { hasUnsavedChanges: true } : {}),
    }));

    if (hasRemoveChange) {
      clearStaleInputImages(removedEdges, get);
      get().incrementManualChangeCount();
    }

    // Recompute dimming when edges are added or removed
    if (hasAddOrRemove) {
      get().recomputeDimmedNodes();
    }
  },

  onConnect: (connection: Connection, edgeDataOverrides?: Record<string, unknown>) => {
    get().pushUndoSnapshot();
    set((state) => {
      const baseData = buildConnectionEdgeData(connection, state.nodes, state.edges);
      let newEdge = {
        ...connection,
        id: `edge-${connection.source}-${connection.target}-${connection.sourceHandle || "default"}-${connection.targetHandle || "default"}`,
        data: edgeDataOverrides ? { ...baseData, ...edgeDataOverrides } : baseData,
      } as WorkflowEdge;
      // Programmatic creators (connection drop menu, quickstart, …) still
      // speak CLASSIC handles ("image"/"text"). On a dyn-pin node those
      // handles don't render, so the edge would be born a ghost — invisible
      // (React Flow #008) yet still resolving into the request body.
      // Normalize to the active scheme; slot counters are seeded from the
      // existing edges so converted edges never collide with occupied slots.
      // Interactive connects already carry rendered handles → no-op.
      const normalizedAll = migrateEdgeHandles(
        state.nodes,
        [...state.edges, newEdge],
        getDynamicPinsEnabled() ? "dynamic" : "classic",
      );
      newEdge = normalizedAll[normalizedAll.length - 1];
      const priorEdges = normalizedAll.slice(0, -1);
      // Dynamic-pin slots hold exactly one edge: if this handle is already
      // occupied, drop the existing edge so the new one replaces it. The pin /
      // slot — and its name — stays the same (only the source changes).
      const base = isDynPin(newEdge.targetHandle)
        ? priorEdges.filter(
            (e) => !(e.target === newEdge.target && e.targetHandle === newEdge.targetHandle)
          )
        : priorEdges;
      // Cast needed: React Flow's Edge<T> types data as T | undefined, but addEdge expects data to be defined
      let nextEdges = addEdge(newEdge, base as never) as WorkflowEdge[];
      // One rule set for what may anchor where: conform the target node's
      // edges to its rendered pins (collapses onto scalar slot 0 with
      // replacement, retargets unmappable fields, drops the truly homeless).
      if (getDynamicPinsEnabled()) {
        const targetNode = state.nodes.find((n) => n.id === newEdge.target);
        if (targetNode) {
          nextEdges = conformEdgesToRenderablePins(targetNode, nextEdges) ?? nextEdges;
        }
      }
      return {
        edges: nextEdges,
        hasUnsavedChanges: true,
      };
    });
    get().incrementManualChangeCount();
    get().recomputeDimmedNodes();
  },

  addEdgeWithType: (connection: Connection, edgeType: string, edgeDataOverrides?: Record<string, unknown>) => {
    get().pushUndoSnapshot();
    set((state) => {
      const baseData = buildConnectionEdgeData(connection, state.nodes, state.edges);
      const newEdge = {
        ...connection,
        id: `edge-${connection.source}-${connection.target}-${connection.sourceHandle || "default"}-${connection.targetHandle || "default"}`,
        type: edgeType,
        data: edgeDataOverrides ? { ...baseData, ...edgeDataOverrides } : baseData,
      };
      return {
        edges: addEdge(newEdge, state.edges as never) as WorkflowEdge[],
        hasUnsavedChanges: true,
      };
    });
  },

  removeEdge: (edgeId: string) => {
    get().pushUndoSnapshot();
    const removedEdge = get().edges.find((e) => e.id === edgeId);
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      hasUnsavedChanges: true,
    }));
    if (removedEdge) clearStaleInputImages([removedEdge], get);
    get().incrementManualChangeCount();
  },

  toggleEdgePause: (edgeId: string) => {
    get().pushUndoSnapshot();
    set((state) => ({
      edges: state.edges.map((edge) =>
        edge.id === edgeId
          ? { ...edge, data: { ...edge.data, hasPause: !edge.data?.hasPause } }
          : edge
      ),
      hasUnsavedChanges: true,
    }));
  },

  copySelectedNodes: () => {
    const { nodes, edges } = get();
    const selectedNodes = nodes.filter((node) => node.selected);

    if (selectedNodes.length === 0) return;

    const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));

    // Copy edges that connect selected nodes to each other
    const connectedEdges = edges.filter(
      (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target)
    );

    // Deep clone the nodes and edges to avoid reference issues
    const clonedNodes = JSON.parse(JSON.stringify(selectedNodes)) as WorkflowNode[];
    const clonedEdges = JSON.parse(JSON.stringify(connectedEdges)) as WorkflowEdge[];

    set({ clipboard: { nodes: clonedNodes, edges: clonedEdges, sourceDirectoryPath: get().saveDirectoryPath } });
  },

  pasteNodes: (offset: XYPosition = { x: 50, y: 50 }) => {
    get().pushUndoSnapshot();
    const { clipboard, nodes, edges } = get();

    if (!clipboard || clipboard.nodes.length === 0) return;

    // Create a mapping from old node IDs to new node IDs
    const idMapping = new Map<string, string>();

    // Generate new IDs for all pasted nodes
    clipboard.nodes.forEach((node) => {
      const newId = `${node.type}-${++nodeIdCounter}`;
      idMapping.set(node.id, newId);
    });

    // Create new nodes with updated IDs and offset positions
    const newNodes: WorkflowNode[] = clipboard.nodes.map((node) => {
      const defaults = defaultNodeDimensions[node.type as NodeType] || { width: 300, height: 280 };
      const clonedData = JSON.parse(JSON.stringify(node.data));

      // Strip generation outputs from generation nodes (keep settings)
      const cleanedData = stripGenerationOutputs(node.type as string, clonedData);

      return {
        ...node,
        id: idMapping.get(node.id)!,
        position: {
          x: node.position.x + offset.x,
          y: node.position.y + offset.y,
        },
        selected: true, // Select newly pasted nodes
        // Reset height to defaults so BaseNode's ResizeObserver
        // can correctly add settings panel height from the right baseline
        style: { width: node.style?.width ?? defaults.width, height: defaults.height },
        width: undefined,
        height: undefined,
        measured: undefined,
        data: cleanedData,
      };
    });

    // Create new edges with updated source/target IDs
    const newEdges: WorkflowEdge[] = clipboard.edges.map((edge) => ({
      ...edge,
      id: `edge-${idMapping.get(edge.source)}-${idMapping.get(edge.target)}-${edge.sourceHandle || "default"}-${edge.targetHandle || "default"}`,
      source: idMapping.get(edge.source)!,
      target: idMapping.get(edge.target)!,
    }));

    // Deselect existing nodes and add new ones
    const updatedNodes = nodes.map((node) => ({
      ...node,
      selected: false,
    }));

    set({
      nodes: [...updatedNodes, ...newNodes] as WorkflowNode[],
      edges: [...edges, ...newEdges],
      hasUnsavedChanges: true,
    });

    // If pasted from a DIFFERENT project, copy the referenced image files into
    // this project and re-point the refs (fire-and-forget; previews fill in as
    // it runs). Without this, pasted nodes point at files in the source project.
    void relocalizeNodeImageRefs(newNodes, clipboard.sourceDirectoryPath ?? null, get().saveDirectoryPath, get().updateNodeData);

    // Fix React Flow selection race condition: After paste, React Flow's internal
    // reconciliation may fire onNodesChange with stale selection state that re-selects
    // original nodes. Schedule an explicit selection correction after reconciliation.
    const newNodeIdSet = new Set(newNodes.map(n => n.id));
    requestAnimationFrame(() => {
      const currentNodes = get().nodes;
      const selectionChanges: NodeChange<WorkflowNode>[] = currentNodes.map(n => ({
        type: 'select' as const,
        id: n.id,
        selected: newNodeIdSet.has(n.id),
      }));
      get().onNodesChange(selectionChanges);
    });
  },

  pasteNodesWithInputs: (offset: XYPosition = { x: 50, y: 50 }) => {
    get().pushUndoSnapshot();
    const { clipboard, nodes, edges } = get();

    if (!clipboard || clipboard.nodes.length === 0) return;

    // Create ID mapping: old → new
    const idMapping = new Map<string, string>();
    clipboard.nodes.forEach((node) => {
      const newId = `${node.type}-${++nodeIdCounter}`;
      idMapping.set(node.id, newId);
    });

    const clipboardNodeIds = new Set(clipboard.nodes.map(n => n.id));

    // Create new nodes with updated IDs and offset positions
    const newNodes: WorkflowNode[] = clipboard.nodes.map((node) => {
      const defaults = defaultNodeDimensions[node.type as NodeType] || { width: 300, height: 280 };
      const clonedData = JSON.parse(JSON.stringify(node.data));
      const cleanedData = stripGenerationOutputs(node.type as string, clonedData);

      return {
        ...node,
        id: idMapping.get(node.id)!,
        position: {
          x: node.position.x + offset.x,
          y: node.position.y + offset.y,
        },
        selected: true,
        style: { width: node.style?.width ?? defaults.width, height: defaults.height },
        width: undefined,
        height: undefined,
        measured: undefined,
        data: cleanedData,
      };
    });

    // Internal edges (between pasted nodes) — remap both source and target
    const internalEdges: WorkflowEdge[] = clipboard.edges.map((edge) => ({
      ...edge,
      id: `edge-${idMapping.get(edge.source)}-${idMapping.get(edge.target)}-${edge.sourceHandle || "default"}-${edge.targetHandle || "default"}`,
      source: idMapping.get(edge.source)!,
      target: idMapping.get(edge.target)!,
    }));

    // Input edges — edges from EXTERNAL source nodes INTO the copied nodes.
    // Keep the original source, remap the target to the new node ID.
    const inputEdges: WorkflowEdge[] = [];
    for (const edge of edges) {
      if (clipboardNodeIds.has(edge.target) && !clipboardNodeIds.has(edge.source)) {
        const newTargetId = idMapping.get(edge.target);
        if (newTargetId) {
          inputEdges.push({
            ...edge,
            id: `edge-${edge.source}-${newTargetId}-${edge.sourceHandle || "default"}-${edge.targetHandle || "default"}`,
            target: newTargetId,
          });
        }
      }
    }

    // Deselect existing nodes
    const updatedNodes = nodes.map((node) => ({
      ...node,
      selected: false,
    }));

    // Clipboard edges may carry the other pin scheme (copied before a flag
    // toggle, or from a classic-era workflow) — normalize so nothing pastes
    // in as a ghost edge.
    const allNodesAfterPaste = [...updatedNodes, ...newNodes] as WorkflowNode[];
    set({
      nodes: allNodesAfterPaste,
      edges: migrateEdgeHandles(
        allNodesAfterPaste,
        [...edges, ...internalEdges, ...inputEdges],
        getDynamicPinsEnabled() ? "dynamic" : "classic",
      ),
      hasUnsavedChanges: true,
    });

    // If pasted from a DIFFERENT project, copy the referenced image files into
    // this project and re-point the refs (fire-and-forget). Without this, pasted
    // nodes point at files that live in the source project's folder.
    void relocalizeNodeImageRefs(newNodes, clipboard.sourceDirectoryPath ?? null, get().saveDirectoryPath, get().updateNodeData);

    // Fix selection race condition
    const newNodeIdSet = new Set(newNodes.map(n => n.id));
    requestAnimationFrame(() => {
      const currentNodes = get().nodes;
      const selectionChanges: NodeChange<WorkflowNode>[] = currentNodes.map(n => ({
        type: 'select' as const,
        id: n.id,
        selected: newNodeIdSet.has(n.id),
      }));
      get().onNodesChange(selectionChanges);
    });
  },

  clearClipboard: () => {
    set({ clipboard: null });
  },

  // Group operations
  createGroup: (nodeIds: string[]) => {
    get().pushUndoSnapshot();
    const { nodes, groups } = get();

    if (nodeIds.length === 0) return "";

    // Get the nodes to group
    const nodesToGroup = nodes.filter((n) => nodeIds.includes(n.id));
    if (nodesToGroup.length === 0) return "";

    // Calculate bounding box of selected nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodesToGroup.forEach((node) => {
      // Use measured dimensions (actual rendered size) first, then style, then type-specific defaults
      const defaults = defaultNodeDimensions[node.type as NodeType] || { width: 300, height: 280 };
      const width = node.measured?.width || (node.style?.width as number) || defaults.width;
      const height = node.measured?.height || (node.style?.height as number) || defaults.height;

      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    });

    // Add padding around nodes
    const padding = 20;

    // Find next available color
    const usedColors = new Set(Object.values(groups).map((g) => g.color));
    let color: GroupColor = "neutral";
    for (const c of GROUP_COLOR_ORDER) {
      if (!usedColors.has(c)) {
        color = c;
        break;
      }
    }

    // Generate ID and name
    const id = `group-${++groupIdCounter}`;
    const groupNumber = Object.keys(groups).length + 1;
    const name = `Group ${groupNumber}`;

    const newGroup: NodeGroup = {
      id,
      name,
      color,
      position: {
        x: minX - padding,
        y: minY - padding,
      },
      size: {
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
      },
    };

    // Update nodes with groupId and add group
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId: id } : node
      ) as WorkflowNode[],
      groups: { ...state.groups, [id]: newGroup },
      hasUnsavedChanges: true,
    }));

    return id;
  },

  deleteGroup: (groupId: string) => {
    get().pushUndoSnapshot();
    set((state) => {
      const { [groupId]: _, ...remainingGroups } = state.groups;
      return {
        nodes: state.nodes.map((node) =>
          node.groupId === groupId ? { ...node, groupId: undefined } : node
        ) as WorkflowNode[],
        groups: remainingGroups,
        hasUnsavedChanges: true,
      };
    });
  },

  addNodesToGroup: (nodeIds: string[], groupId: string) => {
    get().pushUndoSnapshot();
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  removeNodesFromGroup: (nodeIds: string[]) => {
    get().pushUndoSnapshot();
    set((state) => ({
      nodes: state.nodes.map((node) =>
        nodeIds.includes(node.id) ? { ...node, groupId: undefined } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  updateGroup: (groupId: string, updates: Partial<NodeGroup>) => {
    get().pushUndoSnapshot();
    set((state) => ({
      groups: {
        ...state.groups,
        [groupId]: { ...state.groups[groupId], ...updates },
      },
      hasUnsavedChanges: true,
    }));
  },

  toggleGroupLock: (groupId: string) => {
    set((state) => ({
      groups: {
        ...state.groups,
        [groupId]: {
          ...state.groups[groupId],
          locked: !state.groups[groupId].locked,
        },
      },
      hasUnsavedChanges: true,
    }));
  },

  moveGroupNodes: (groupId: string, delta: { x: number; y: number }) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.groupId === groupId
          ? {
              ...node,
              position: {
                x: node.position.x + delta.x,
                y: node.position.y + delta.y,
              },
            }
          : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  setNodeGroupId: (nodeId: string, groupId: string | undefined) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, groupId } : node
      ) as WorkflowNode[],
      hasUnsavedChanges: true,
    }));
  },

  getNodeById: (id: string) => {
    return get().nodes.find((node) => node.id === id);
  },

  getConnectedInputs: (nodeId: string) => {
    const { edges, nodes, dimmedNodeIds } = get();
    return getConnectedInputsPure(nodeId, nodes, edges, undefined, dimmedNodeIds);
  },

  validateWorkflow: () => {
    const { nodes, edges } = get();
    return validateWorkflowPure(nodes, edges);
  },

  _buildExecutionContext: (node: WorkflowNode, signal?: AbortSignal): NodeExecutionContext => ({
    node,
    getConnectedInputs: get().getConnectedInputs,
    updateNodeData: get().updateNodeData,
    getFreshNode: (id: string) => get().nodes.find((n) => n.id === id),
    getEdges: () => get().edges,
    getNodes: () => get().nodes,
    signal,
    providerSettings: get().providerSettings,
    addIncurredCost: (cost: number) => get().addIncurredCost(cost),
    addToGlobalHistory: (item) => get().addToGlobalHistory(item),
    generationsPath: get().generationsPath,
    saveDirectoryPath: get().saveDirectoryPath,
    trackSaveGeneration: (key: string, promise: Promise<void>) => {
      pendingImageSyncs.set(key, promise);
      promise.finally(() => pendingImageSyncs.delete(key));
    },
    appendOutputGalleryImage: (targetId: string, image: string) => {
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === targetId && n.type === "outputGallery"
            ? { ...n, data: { ...n.data, images: [image, ...((n.data as OutputGalleryNodeData).images || [])] } as WorkflowNodeData }
            : n
        ) as WorkflowNode[],
        hasUnsavedChanges: true,
      }));
    },
    get: get as () => unknown,
  }),

  executeWorkflow: async (startFromNodeId?: string) => {
    const { nodes, edges, groups, isRunning, maxConcurrentCalls } = get();

    if (isRunning) {
      logger.warn('workflow.start', 'Workflow already running, ignoring execution request');
      return;
    }

    // Create AbortController for this execution run
    const abortController = new AbortController();
    const isResuming = startFromNodeId === get().pausedAtNodeId;
    set({ isRunning: true, pausedAtNodeId: null, currentNodeIds: [], _abortController: abortController });

    // Start logging session
    await logger.startSession();

    logger.info('workflow.start', 'Workflow execution started', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      startFromNodeId,
      isResuming,
      maxConcurrentCalls,
    });

    // Group nodes by level for parallel execution
    const levels = groupNodesByLevel(nodes, edges);

    // Find starting level if startFromNodeId specified
    let startLevel = 0;
    if (startFromNodeId) {
      const foundLevel = levels.findIndex((l) => l.nodeIds.includes(startFromNodeId));
      if (foundLevel !== -1) startLevel = foundLevel;
    }

    // Lazy full-res pre-pass: displayed images are NULL on open. Load full-res
    // for the nodes that will run (+ their upstream producers) so executors read
    // real pixels instead of empty fields. No-ops on already-loaded images.
    try {
      const execIds = levels.slice(startLevel).flatMap((l) => l.nodeIds);
      await ensureFullResForNodes(execIds, get().nodes, get().edges, get().updateNodeData, get().saveDirectoryPath);
    } catch (err) {
      logger.warn('workflow.start', 'Full-res pre-pass failed (continuing)', { error: String(err) });
    }

    // Helper to execute a single node - returns true if successful, throws on error
    const executeSingleNode = async (node: WorkflowNode, signal: AbortSignal): Promise<void> => {
      // Check for abort before starting
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Check if node is dimmed (downstream of disabled Switch output)
      const dimmedNodeIds = get().dimmedNodeIds;
      if (dimmedNodeIds.has(node.id)) {
        // Skip execution — node is dimmed
        // Keep previous output visible (don't clear node data)
        logger.info('node.execution', 'Node skipped (downstream of disabled Switch)', {
          nodeId: node.id,
          nodeType: node.type,
        });
        return;
      }

      // Check for pause edges on incoming connections (skip if resuming from this exact node)
      const isResumingThisNode = isResuming && node.id === startFromNodeId;
      if (!isResumingThisNode) {
        const incomingEdges = edges.filter((e) => e.target === node.id);
        const pauseEdge = incomingEdges.find((e) => e.data?.hasPause);
        if (pauseEdge) {
          logger.info('workflow.end', 'Workflow paused at node', {
            nodeId: node.id,
            nodeType: node.type,
          });
          set({ pausedAtNodeId: node.id });
          useToast.getState().show("Workflow paused - click Run to continue", "warning");

          // Signal to stop the entire workflow — outer loop handles isRunning/session cleanup
          abortController.abort();
          return;
        }
      }

      // Check if node is in a locked group - if so, skip execution
      const nodeGroup = node.groupId ? groups[node.groupId] : null;
      if (nodeGroup?.locked) {
        logger.info('node.execution', `Skipping node in locked group`, {
          nodeId: node.id,
          nodeType: node.type,
          groupId: node.groupId,
          groupName: nodeGroup.name,
        });
        return; // Skip this node but continue with others
      }

      logger.info('node.execution', `Executing ${node.type} node`, {
        nodeId: node.id,
        nodeType: node.type,
      });

      const executionCtx = get()._buildExecutionContext(node, signal);

      switch (node.type) {
          case "imageInput":
          case "panoCrop":
            // Data source nodes - no execution needed
            break;
          case "audioInput": {
            // If audio is connected from upstream, use it (connection wins over upload)
            const audioInputs = get().getConnectedInputs(node.id);
            if (audioInputs.audio.length > 0 && audioInputs.audio[0]) {
              get().updateNodeData(node.id, { audioFile: audioInputs.audio[0] });
            }
            break;
          }
          case "videoInput": {
            // If video is connected from upstream, use it (connection wins over upload)
            const videoInputs = get().getConnectedInputs(node.id);
            if (videoInputs.videos.length > 0 && videoInputs.videos[0]) {
              get().updateNodeData(node.id, { videoFile: videoInputs.videos[0] });
            }
            break;
          }
          case "glbViewer":
            await executeGlbViewer(executionCtx);
            break;
          case "spzViewer":
            await executeSpzViewer(executionCtx);
            break;
          case "panoViewer":
            await executePanoViewer(executionCtx);
            break;
          case "panoEditor":
            await executePanoEditor(executionCtx);
            break;
          case "annotation":
            await executeAnnotation(executionCtx);
            break;
          case "prompt":
            await executePrompt(executionCtx);
            break;
          case "array":
            await executeArray(executionCtx);
            break;
          case "promptConstructor":
            await executePromptConstructor(executionCtx);
            break;
          case "nanoBanana":
            await executeNanoBanana(executionCtx);
            break;
          case "generateVideo":
            await executeGenerateVideo(executionCtx);
            break;
          case "generate3d":
            await executeGenerate3D(executionCtx);
            break;
          case "generateAudio":
            await executeGenerateAudio(executionCtx);
            break;
          case "llmGenerate":
            await executeLlmGenerate(executionCtx);
            break;
          case "splitGrid":
            await executeSplitGrid(executionCtx);
            break;
          case "output":
            await executeOutput(executionCtx);
            break;
          case "outputGallery":
            await executeOutputGallery(executionCtx);
            break;
          case "imageCompare":
            await executeImageCompare(executionCtx);
            break;
          case "videoCompare":
            await executeVideoCompare(executionCtx);
            break;
          case "videoStitch":
            await executeVideoStitch(executionCtx);
            break;
          case "easeCurve":
            await executeEaseCurve(executionCtx);
            break;
          case "videoTrim":
            await executeVideoTrim(executionCtx);
            break;
          case "videoFrameGrab":
            await executeVideoFrameGrab(executionCtx);
            break;
          case "maskPainter":
            await executeMaskPainter(executionCtx);
            break;
          case "router":
            await executeRouter(executionCtx);
            break;
          case "switch":
            await executeSwitch(executionCtx);
            break;
          case "conditionalSwitch":
            await evaluateAndExecuteConditionalSwitch(node, executionCtx, get().getConnectedInputs, get().updateNodeData);
            break;
        }
    }; // End of executeSingleNode helper

    try {
      // Execute levels sequentially, but nodes within each level in parallel
      for (let levelIdx = startLevel; levelIdx < levels.length; levelIdx++) {
        // Check if execution was stopped
        if (abortController.signal.aborted || !get().isRunning) break;

        const level = levels[levelIdx];
        const levelNodes = level.nodeIds
          .map((id) => nodes.find((n) => n.id === id))
          .filter((n): n is WorkflowNode => n !== undefined);

        if (levelNodes.length === 0) continue;

        // Execute nodes in batches respecting concurrency limit
        const batches = chunk(levelNodes, maxConcurrentCalls);

        for (const batch of batches) {
          if (abortController.signal.aborted || !get().isRunning) break;

          // Update currentNodeIds to show which nodes are executing
          const batchIds = batch.map((n) => n.id);
          set({ currentNodeIds: batchIds });

          logger.info('node.execution', `Executing level ${levelIdx} batch`, {
            level: levelIdx,
            nodeCount: batch.length,
            nodeIds: batchIds,
          });

          // Execute batch in parallel
          const results = await Promise.allSettled(
            batch.map((node) => executeSingleNode(node, abortController.signal))
          );

          // Check for failures with node context (fail-fast behavior)
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'rejected' &&
                !(r.reason instanceof DOMException && r.reason.name === 'AbortError')) {
              const failedNode = batch[i];
              logger.error('workflow.error', 'Node execution failed in parallel batch', {
                level: levelIdx,
                nodeId: failedNode.id,
                nodeType: failedNode.type,
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              });
              abortController.abort();
              throw r.reason;
            }
          }
        }
      }

      // Check if we completed or were aborted
      if (!abortController.signal.aborted && get().isRunning) {
        logger.info('workflow.end', 'Workflow execution completed successfully');
      }

      set({ isRunning: false, currentNodeIds: [], _abortController: null });

      saveLogSession();
      await logger.endSession();
    } catch (error) {
      // Handle AbortError gracefully (user cancelled)
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.info('workflow.end', 'Workflow execution cancelled by user');
      } else {
        logger.error('workflow.error', 'Workflow execution failed', {}, error instanceof Error ? error : undefined);
        // Show error toast for the failed node
        useToast.getState().show(
          `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          "error"
        );
      }
      set({ isRunning: false, currentNodeIds: [], _abortController: null });

      saveLogSession();
      await logger.endSession();
    }
  },

  stopWorkflow: () => {
    // Abort any in-flight requests
    const controller = get()._abortController;
    if (controller) {
      controller.abort("user-cancelled");
    }
    set({ isRunning: false, currentNodeIds: [], _abortController: null });
  },

  setMaxConcurrentCalls: (value: number) => {
    const clamped = Math.max(1, Math.min(10, value));
    saveConcurrencySetting(clamped);
    set({ maxConcurrentCalls: clamped });
  },

  regenerateNode: async (nodeId: string) => {
    const { nodes, edges, updateNodeData, currentNodeIds } = get();

    // Per-node gating: refuse only when *this* node is currently in
    // flight, or when one of its transitive upstream deps is. Unrelated
    // in-flight work elsewhere in the graph no longer blocks us, so the
    // user can Run nodes in parallel as long as their inputs are stable.
    const blocker = getRunBlocker(nodeId, currentNodeIds, nodes, edges);
    if (blocker) {
      logger.warn('node.execution', 'Cannot regenerate node, blocked by in-flight work', {
        nodeId,
        blockerNodeId: blocker.id,
        blockerKind: blocker.kind,
      });
      return;
    }

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      logger.warn('node.error', 'Node not found for regeneration', { nodeId });
      return;
    }

    // Add this node to the in-flight set without disturbing other runs.
    // `isRunning` is derived: true when any node is executing. We cleanup
    // in the matching try/finally below.
    set((s) => ({
      isRunning: true,
      currentNodeIds: [...s.currentNodeIds, nodeId],
    }));
    // Inline finalizer used by every exit path below — removes this node
    // from currentNodeIds and updates isRunning based on what's left.
    const finalize = () => {
      set((s) => {
        const remaining = s.currentNodeIds.filter((id) => id !== nodeId);
        return { isRunning: remaining.length > 0, currentNodeIds: remaining };
      });
    };

    await logger.startSession();
    logger.info('node.execution', 'Regenerating node', {
      nodeId,
      nodeType: node.type,
    });

    try {
      // Lazy full-res pre-pass: load full-res for this node + its upstream so
      // the executor reads real pixels (connected inputs or stored fallback).
      try {
        await ensureFullResForNodes([nodeId], get().nodes, get().edges, get().updateNodeData, get().saveDirectoryPath);
      } catch (err) {
        logger.warn('node.execution', 'Full-res pre-pass failed (continuing)', { nodeId, error: String(err) });
      }

      // Freshness pre-pass: re-run cheap LOCAL processors upstream (reformat,
      // color grade, roto, comp, …) so this node reads CURRENT data — their
      // outputImage is otherwise whatever the last run left behind, silently
      // feeding stale pixels downstream. API generators keep cached outputs.
      try {
        const { groups } = get();
        await refreshUpstreamProcessors(
          [nodeId],
          get().nodes,
          get().edges,
          (n) => get()._buildExecutionContext(n),
          (id) => {
            const n = get().nodes.find((x) => x.id === id);
            return !!(n?.groupId && groups[n.groupId]?.locked);
          },
        );
      } catch (err) {
        logger.warn('node.execution', 'Upstream freshness pre-pass failed (continuing)', { nodeId, error: String(err) });
      }

      const executionCtx = get()._buildExecutionContext(node);

      const regenOptions = { useStoredFallback: true };

      if (node.type === "nanoBanana") {
        await executeNanoBanana(executionCtx, regenOptions);
      } else if (node.type === "upscaleGrid") {
        await executeUpscaleGrid(executionCtx);
      } else if (node.type === "array") {
        await executeArray(executionCtx);
      } else if (node.type === "llmGenerate") {
        await executeLlmGenerate(executionCtx, regenOptions);
      } else if (node.type === "generateVideo") {
        await executeGenerateVideo(executionCtx, regenOptions);
      } else if (node.type === "generate3d") {
        await executeGenerate3D(executionCtx, regenOptions);
      } else if (node.type === "image2GS") {
        await executeImage2GS(executionCtx);
      } else if (node.type === "generateAudio") {
        await executeGenerateAudio(executionCtx, regenOptions);
      } else if (node.type === "splitGrid") {
        await executeSplitGrid(executionCtx);
      } else if (node.type === "videoStitch") {
        await executeVideoStitch(executionCtx);
        finalize();
        await logger.endSession();
        return;
      } else if (node.type === "easeCurve") {
        await executeEaseCurve(executionCtx);
        finalize();
        await logger.endSession();
        return;
      } else if (node.type === "worldLabsPano") {
        await executeWorldLabsPano(executionCtx);
      } else if (node.type === "worldLabsWorld") {
        await executeWorldLabsWorld(executionCtx);
      } else if (node.type === "panoViewer") {
        await executePanoViewer(executionCtx);
      } else if (node.type === "panoEditor") {
        await executePanoEditor(executionCtx);
      } else if (node.type === "videoTrim") {
        await executeVideoTrim(executionCtx);
        finalize();
        await logger.endSession();
        return;
      } else if (node.type === "videoFrameGrab") {
        await executeVideoFrameGrab(executionCtx);
        finalize();
        await logger.endSession();
        return;
      } else if (node.type === "output") {
        await executeOutput(executionCtx);
        finalize();
        await logger.endSession();
        return;
      } else if (node.type === "maskPainter") {
        await executeMaskPainter(executionCtx);
      } else if (node.type === "sphereLightRender") {
        await executeSphereLightRender(executionCtx);
      }

      // After regeneration, execute directly connected downstream consumer nodes
      // (e.g. glbViewer needs to fetch+load 3D model from upstream nanoBanana)
      const { edges: currentEdges } = get();
      const downstreamEdges = currentEdges.filter(e => e.source === nodeId);
      for (const edge of downstreamEdges) {
        const targetNode = get().nodes.find(n => n.id === edge.target);
        if (!targetNode) continue;
        const targetCtx = get()._buildExecutionContext(targetNode);
        switch (targetNode.type) {
          case "glbViewer":
            await executeGlbViewer(targetCtx);
            break;
          case "spzViewer":
            await executeSpzViewer(targetCtx);
            break;
          case "panoViewer":
            await executePanoViewer(targetCtx);
            break;
          case "panoEditor":
            await executePanoEditor(targetCtx);
            break;
          case "output":
            await executeOutput(targetCtx);
            break;
          case "outputGallery":
            await executeOutputGallery(targetCtx);
            break;
          case "imageCompare":
            await executeImageCompare(targetCtx);
            break;
          case "videoCompare":
            await executeVideoCompare(targetCtx);
            break;
        }
      }

      logger.info('node.execution', 'Node regeneration completed successfully', { nodeId });
      finalize();

      saveLogSession();
      await logger.endSession();
    } catch (error) {
      // Log full stack trace to browser console for debugging
      console.error('[regenerateNode] failed:', error);
      logger.error('node.error', 'Node regeneration failed', {
        nodeId,
      }, error instanceof Error ? error : undefined);
      updateNodeData(nodeId, {
        status: "error",
        error: error instanceof Error ? error.message : "Regeneration failed",
      });
      finalize();

      // Teardown must never throw: an exception here would escape the catch
      // with the node still looking in-flight — dimming its (and downstream)
      // Run buttons until a page reload.
      try {
        saveLogSession();
        await logger.endSession();
      } catch (teardownErr) {
        console.error('[regenerateNode] log-session teardown failed:', teardownErr);
      }
    }
  },

  propagateFromNode: async (nodeId: string) => {
    try {
      await refreshDownstreamProcessors(
        [nodeId],
        get().nodes,
        get().edges,
        (n) => get()._buildExecutionContext(n),
      );
    } catch (err) {
      console.warn("[live] propagateFromNode failed", nodeId, err);
    }
  },

  loadNodeFullResInputs: async (nodeId: string) => {
    const { nodes, edges, updateNodeData, saveDirectoryPath } = get();
    try {
      await ensureFullResForNodes([nodeId], nodes, edges, updateNodeData, saveDirectoryPath);
    } catch (err) {
      logger.warn('node.execution', 'loadNodeFullResInputs failed', { nodeId, error: String(err) });
    }
  },

  executeSelectedNodes: async (nodeIds: string[]) => {
    const { nodes, edges, isRunning, maxConcurrentCalls } = get();

    if (isRunning) {
      logger.warn('node.execution', 'Cannot execute nodes, workflow already running');
      return;
    }

    if (nodeIds.length === 0) {
      logger.warn('node.execution', 'No nodes provided for execution');
      return;
    }

    // Filter to valid nodes
    const selectedSet = new Set(nodeIds);
    const nodesToExecute = nodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is WorkflowNode => n !== undefined);

    if (nodesToExecute.length === 0) {
      logger.warn('node.execution', 'No valid nodes found for execution');
      return;
    }

    // Create AbortController for this execution run
    const abortController = new AbortController();
    set({ isRunning: true, currentNodeIds: nodeIds, _abortController: abortController });

    await logger.startSession();
    logger.info('node.execution', 'Executing selected nodes', {
      nodeCount: nodesToExecute.length,
      nodeIds,
    });

    // Helper to execute a single node
    const executeNode = async (node: WorkflowNode, signal: AbortSignal) => {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      logger.info('node.execution', `Executing ${node.type} node`, {
        nodeId: node.id,
        nodeType: node.type,
      });

      const executionCtx = get()._buildExecutionContext(node, signal);
      const regenOptions = { useStoredFallback: true };

      switch (node.type) {
        case "imageInput":
        case "audioInput":
        case "videoInput":
        case "panoCrop":
          // Data source nodes - no execution needed
          break;
        case "glbViewer":
          await executeGlbViewer(executionCtx);
          break;
        case "spzViewer":
          await executeSpzViewer(executionCtx);
          break;
        case "panoViewer":
          await executePanoViewer(executionCtx);
          break;
        case "panoEditor":
          await executePanoEditor(executionCtx);
          break;
        case "annotation":
          await executeAnnotation(executionCtx);
          break;
        case "prompt":
          await executePrompt(executionCtx);
          break;
        case "array":
          await executeArray(executionCtx);
          break;
        case "promptConstructor":
          await executePromptConstructor(executionCtx);
          break;
        case "nanoBanana":
          await executeNanoBanana(executionCtx, regenOptions);
          break;
        case "generateVideo":
          await executeGenerateVideo(executionCtx, regenOptions);
          break;
        case "generate3d":
          await executeGenerate3D(executionCtx, regenOptions);
          break;
        case "image2GS":
          await executeImage2GS(executionCtx);
          break;
        case "llmGenerate":
          await executeLlmGenerate(executionCtx, regenOptions);
          break;
        case "generateAudio":
          await executeGenerateAudio(executionCtx, regenOptions);
          break;
        case "splitGrid":
          await executeSplitGrid(executionCtx);
          break;
        case "upscaleGrid":
          await executeUpscaleGrid(executionCtx);
          break;
        case "output":
          await executeOutput(executionCtx);
          break;
        case "outputGallery":
          await executeOutputGallery(executionCtx);
          break;
        case "imageCompare":
          await executeImageCompare(executionCtx);
          break;
        case "videoStitch":
          await executeVideoStitch(executionCtx);
          break;
        case "easeCurve":
          await executeEaseCurve(executionCtx);
          break;
        case "videoTrim":
          await executeVideoTrim(executionCtx);
          break;
        case "videoFrameGrab":
          await executeVideoFrameGrab(executionCtx);
          break;
        case "router":
          await executeRouter(executionCtx);
          break;
        case "switch":
          await executeSwitch(executionCtx);
          break;
        case "conditionalSwitch":
          await evaluateAndExecuteConditionalSwitch(node, executionCtx, get().getConnectedInputs, get().updateNodeData);
          break;
      }
    };

    try {
      // Lazy full-res pre-pass: load full-res for the selected nodes + their
      // upstream (across the full graph) so executors read real pixels.
      try {
        await ensureFullResForNodes(nodeIds, get().nodes, get().edges, get().updateNodeData, get().saveDirectoryPath);
      } catch (err) {
        logger.warn('node.execution', 'Full-res pre-pass failed (continuing)', { error: String(err) });
      }

      // Freshness pre-pass: re-run cheap LOCAL processors upstream of the
      // selection (excluding the selection itself) so executors read CURRENT
      // data instead of stale outputs from a previous run.
      try {
        const { groups } = get();
        await refreshUpstreamProcessors(
          nodeIds,
          get().nodes,
          get().edges,
          (n) => get()._buildExecutionContext(n, abortController.signal),
          (id) => {
            const n = get().nodes.find((x) => x.id === id);
            return !!(n?.groupId && groups[n.groupId]?.locked);
          },
        );
      } catch (err) {
        logger.warn('node.execution', 'Upstream freshness pre-pass failed (continuing)', { error: String(err) });
      }

      // Filter edges to only those within the selected set for topological sort
      const selectedEdges = edges.filter(
        (e) => selectedSet.has(e.source) && selectedSet.has(e.target)
      );

      // Group selected nodes by dependency level for ordered execution
      const levels = groupNodesByLevel(nodesToExecute, selectedEdges);

      // Collect per-node failures across the whole run so one node's error
      // (e.g. a transient provider 503) doesn't abort the rest.
      const nodeFailures: string[] = [];

      // Execute levels sequentially, nodes within each level in parallel batches
      for (const level of levels) {
        if (abortController.signal.aborted || !get().isRunning) break;

        const levelNodes = level.nodeIds
          .map((id) => nodesToExecute.find((n) => n.id === id))
          .filter((n): n is WorkflowNode => n !== undefined);

        if (levelNodes.length === 0) continue;

        const batches = chunk(levelNodes, maxConcurrentCalls);

        for (const batch of batches) {
          if (abortController.signal.aborted || !get().isRunning) break;

          const batchIds = batch.map((n) => n.id);
          set({ currentNodeIds: batchIds });

          logger.info('node.execution', `Executing batch of selected nodes`, {
            level: level.level,
            nodeCount: batch.length,
            nodeIds: batchIds,
          });

          const results = await Promise.allSettled(
            batch.map((node) => executeNode(node, abortController.signal))
          );

          // Collect per-node failures (excluding user-cancel AbortErrors) but
          // KEEP GOING — one node's transient error (e.g. a provider 503)
          // shouldn't abort the whole run. Each failed node already shows its
          // own error state; nodes downstream of a failed one surface their own
          // missing-input error when they execute.
          results.forEach((r, i) => {
            if (
              r.status === 'rejected' &&
              !(r.reason instanceof DOMException && r.reason.name === 'AbortError')
            ) {
              const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
              nodeFailures.push(batch[i].id);
              logger.error('node.error', 'Node execution failed in batch (continuing)', {
                level: level.level,
                nodeId: batch[i].id,
                error: msg,
              });
            }
          });
        }
      }

      // Propagate to downstream consumer nodes not in the selected set
      if (!abortController.signal.aborted && get().isRunning) {
        const { edges: currentEdges } = get();
        const propagated = new Set<string>();
        for (const nodeId of nodeIds) {
          const downstreamEdges = currentEdges.filter(e => e.source === nodeId);
          for (const edge of downstreamEdges) {
            if (selectedSet.has(edge.target) || propagated.has(edge.target)) continue;
            const targetNode = get().nodes.find(n => n.id === edge.target);
            if (!targetNode) continue;
            const targetCtx = get()._buildExecutionContext(targetNode);
            switch (targetNode.type) {
              case "glbViewer":
                await executeGlbViewer(targetCtx);
                propagated.add(edge.target);
                break;
              case "spzViewer":
                await executeSpzViewer(targetCtx);
                propagated.add(edge.target);
                break;
              case "panoViewer":
                await executePanoViewer(targetCtx);
                propagated.add(edge.target);
                break;
              case "panoEditor":
                await executePanoEditor(targetCtx);
                propagated.add(edge.target);
                break;
              case "output":
                await executeOutput(targetCtx);
                propagated.add(edge.target);
                break;
              case "outputGallery":
                await executeOutputGallery(targetCtx);
                propagated.add(edge.target);
                break;
              case "imageCompare":
                await executeImageCompare(targetCtx);
                propagated.add(edge.target);
                break;
              case "videoCompare":
                await executeVideoCompare(targetCtx);
                propagated.add(edge.target);
                break;
            }
          }
        }
      }

      if (nodeFailures.length > 0) {
        logger.info('node.execution', `Selected nodes execution completed with ${nodeFailures.length} failure(s)`, { failedNodeIds: nodeFailures });
        useToast.getState().show(
          `${nodeFailures.length} node${nodeFailures.length === 1 ? '' : 's'} failed — see the highlighted node(s) for details.`,
          "error"
        );
      } else {
        logger.info('node.execution', 'Selected nodes execution completed successfully');
      }
      set({ isRunning: false, currentNodeIds: [], _abortController: null });

      saveLogSession();
      await logger.endSession();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.info('node.execution', 'Selected nodes execution cancelled by user');
      } else {
        logger.error('node.error', 'Selected nodes execution failed', {}, error instanceof Error ? error : undefined);
        useToast.getState().show(
          `Execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          "error"
        );
      }
      set({ isRunning: false, currentNodeIds: [], _abortController: null });

      saveLogSession();
      await logger.endSession();
    }
  },

  saveWorkflow: (name?: string) => {
    const { nodes, edges, edgeStyle, groups } = get();

    const workflow: WorkflowFile = {
      version: 1,
      name: name || `workflow-${new Date().toISOString().slice(0, 10)}`,
      // Strip selected property - selection is transient UI state and should not be persisted
      nodes: nodes.map(({ selected, ...rest }) => rest),
      edges,
      edgeStyle,
      groups: groups && Object.keys(groups).length > 0 ? groups : undefined,
    };

    const json = JSON.stringify(workflow, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `${workflow.name}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },

  migratePinMode: (enabled: boolean) => {
    const { nodes, edges } = get();
    const migrated = migrateEdgeHandles(nodes, edges, enabled ? "dynamic" : "classic");
    // migrateEdgeHandles reuses unchanged edge refs, so a cheap identity check
    // tells us whether anything actually moved (avoids needless re-render / churn).
    const changed = migrated.length !== edges.length || migrated.some((e, i) => e !== edges[i]);
    if (changed) set({ edges: migrated });
  },

  loadWorkflow: async (workflow: WorkflowFile, workflowPath?: string, options?: { preserveSnapshot?: boolean }) => {
    // Free old workflow data before loading new one to reduce peak memory
    deletedNodesCache.clear();
    pendingImageSyncs.clear();
    set({ nodes: [], edges: [], undoStack: [], redoStack: [], groups: {} });

    // Update nodeIdCounter to avoid ID collisions
    const maxNodeId = workflow.nodes.reduce((max, node) => {
      const match = node.id.match(/-(\d+)$/);
      if (match) {
        return Math.max(max, parseInt(match[1], 10));
      }
      return max;
    }, 0);
    nodeIdCounter = maxNodeId;

    // Update groupIdCounter to avoid ID collisions
    const maxGroupId = Object.keys(workflow.groups || {}).reduce((max, id) => {
      const match = id.match(/-(\d+)$/);
      if (match) {
        return Math.max(max, parseInt(match[1], 10));
      }
      return max;
    }, 0);
    groupIdCounter = maxGroupId;

    // Migrate legacy nanoBanana nodes: derive selectedModel from model field if missing
    workflow.nodes = workflow.nodes.map((node) => {
      if (node.type === "nanoBanana") {
        const data = node.data as NanoBananaNodeData;
        if (data.model && !data.selectedModel) {
          const displayName = MODEL_DISPLAY_NAMES[data.model] || data.model;
          return {
            ...node,
            data: {
              ...data,
              selectedModel: {
                provider: "gemini" as ProviderType,
                modelId: data.model,
                displayName,
              },
            },
          };
        }
      }
      return node;
    }) as WorkflowNode[];

    // Migrate legacy indexed handle IDs ("image-0"/"text-0") on edges
    // targeting generator nodes — see migrateLegacyIndexedHandles.
    workflow.edges = migrateLegacyIndexedHandles(workflow.nodes, workflow.edges);

    // Migrate legacy output node handle IDs: "image"/"audio"/"3d" → "universal"
    // Output nodes now use a single "universal" handle instead of separate typed handles.
    const outputNodeIds = new Set(
      workflow.nodes.filter((n) => n.type === "output").map((n) => n.id)
    );
    workflow.edges = workflow.edges.map((edge) => {
      if (!outputNodeIds.has(edge.target)) return edge;
      const th = edge.targetHandle;
      if (th === "image" || th === "audio" || th === "3d") {
        return { ...edge, targetHandle: "universal" };
      }
      return edge;
    });

    // Deduplicate edges by ID (keep the last occurrence, which is the most recent)
    const edgeById = new Map<string, WorkflowEdge>();
    for (const edge of workflow.edges) {
      edgeById.set(edge.id, edge);
    }
    if (edgeById.size < workflow.edges.length) {
      workflow.edges = Array.from(edgeById.values());
    }

    // Sanitize edges: remove edges referencing non-existent nodes or stale dynamic handles.
    // Dynamic handles (e.g. "image-mask_url") are derived from a node's inputSchema.
    // When the model changes, the schema changes too, but old edges persist — causing
    // React Flow to fire warnings on every render and potentially overflowing the call stack.
    {
      const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));
      const beforeCount = workflow.edges.length;
      workflow.edges = workflow.edges.filter((edge) => {
        // Remove edges targeting/sourcing nodes that no longer exist
        const sourceNode = nodeMap.get(edge.source);
        const targetNode = nodeMap.get(edge.target);
        if (!sourceNode || !targetNode) return false;

        // Validate compound dynamic handles (e.g. "image-mask_url") against inputSchema
        const th = edge.targetHandle;
        if (th) {
          // Skip static handles that are hardcoded on components (not schema-derived)
          if (th === "image-bg") {
            return true;
          }
          const dashIdx = th.indexOf("-");
          if (dashIdx > 0) {
            const suffix = th.slice(dashIdx + 1);
            // Skip indexed handles like "image-0", "image-1" (panoEditor etc.)
            if (!/^\d+$/.test(suffix)) {
              const targetData = targetNode.data as Record<string, unknown>;
              const schema = targetData.inputSchema as Array<{ name: string; type: string }> | undefined;
              if (schema) {
                const exists = schema.some((s) => s.name === suffix);
                if (!exists) {
                  console.warn(`[loadWorkflow] Removing stale edge ${edge.id}: handle "${th}" not in inputSchema`);
                  return false;
                }
              }
            }
          }
        }
        return true;
      });
      if (workflow.edges.length < beforeCount) {
        console.log(`[loadWorkflow] Sanitized ${beforeCount - workflow.edges.length} invalid edge(s)`);
      }
    }

    // Look up saved config from localStorage (only if workflow has an ID)
    const configs = loadSaveConfigs();
    const savedConfig = workflow.id ? configs[workflow.id] : null;

    // Determine the workflow directory path (passed in, from saved config, or embedded in legacy workflow JSON)
    const directoryPath = workflowPath || savedConfig?.directoryPath || workflow.directoryPath || null;

    // Hydrate images if we have a directory path and the workflow has image refs
    let hydratedWorkflow = workflow;
    if (directoryPath) {
      try {
        hydratedWorkflow = await hydrateWorkflowImages(workflow, directoryPath);
      } catch (error) {
        console.error("Failed to hydrate workflow images:", error);
        // Continue with original workflow if hydration fails
      }
    }

    // Load cost data for this workflow
    const costData = workflow.id ? loadWorkflowCostData(workflow.id) : null;

    // Normalize edge handles to the active pin scheme so connections anchor
    // regardless of which mode the file was saved in — then sweep ghost
    // edges (rewire leftovers that anchor to no rendered handle).
    const finalEdges = sweepGhostEdges(
      hydratedWorkflow.nodes,
      migrateEdgeHandles(
        hydratedWorkflow.nodes,
        hydratedWorkflow.edges,
        getDynamicPinsEnabled() ? "dynamic" : "classic"
      )
    );

    set({
      // Clear selected state - selection should not be persisted across sessions
      // Also validate position to ensure coordinates are finite numbers
      nodes: hydratedWorkflow.nodes.map(node => ({
        ...node,
        selected: false,
        position: {
          x: isFinite(node.position?.x) ? node.position.x : 0,
          y: isFinite(node.position?.y) ? node.position.y : 0,
        },
      })),
      edges: finalEdges,
      edgeStyle: hydratedWorkflow.edgeStyle || "angular",
      groups: hydratedWorkflow.groups || {},
      isRunning: false,
      currentNodeIds: [],
      // Restore workflow ID and paths from localStorage if available
      workflowId: workflow.id || null,
      workflowName: workflow.name,
      saveDirectoryPath: directoryPath || null,
      // Derive the generations folder from THIS file's own directory rather than
      // the saved config. The config is keyed by workflow id, so every copy of a
      // template (which all share the baked-in id) would otherwise read one
      // shared generations path — causing images generated in one copy to be
      // written into a sibling copy's folder. Generations always live alongside
      // the workflow (see setWorkflowMetadata / Header "auto-derived").
      generationsPath: directoryPath
        ? `${directoryPath.replace(/\\/g, "/")}/generations`
        : (savedConfig?.generationsPath || null),
      lastSavedAt: savedConfig?.lastSavedAt || null,
      hasUnsavedChanges: false,
      // Restore cost data
      incurredCost: costData?.incurredCost || 0,
      // Track where imageRefs are valid from
      imageRefBasePath: directoryPath || null,
      // Restore image storage setting (default to true for backwards compatibility)
      useExternalImageStorage: savedConfig?.useExternalImageStorage ?? true,
      // Reset viewed comments when loading new workflow
      viewedCommentNodeIds: new Set<string>(),
      // Clear undo/redo stacks for fresh workflow
      undoStack: [],
      redoStack: [],
      _lastSnapshotTime: Date.now() + 3000, // Suppress snapshots for 3s after load
      // Dismiss welcome modal after loading a workflow
      showQuickstart: false,
    });
    deletedNodesCache.clear();

    // Post-load: restore 3D models in GLB viewers with stale blob URLs
    // Blob URLs (blob:http://...) are ephemeral and become invalid after page reload.
    // Find glbViewer nodes with dead blob URLs and auto-restore from connected generate3d nodes.
    const loadedNodes = get().nodes;
    const loadedEdges = get().edges;

    for (const node of loadedNodes) {
      if (node.type !== "glbViewer") continue;
      const viewerData = node.data as GLBViewerNodeData;

      // Only act on stale blob URLs or null — skip valid remote URLs
      const hasStaleUrl = viewerData.glbUrl?.startsWith("blob:") || false;
      const hasNoUrl = !viewerData.glbUrl;

      if (!hasStaleUrl && !hasNoUrl) continue;

      // Clear dead blob URL immediately so the viewer shows placeholder (not broken state)
      if (hasStaleUrl) {
        get().updateNodeData(node.id, { glbUrl: null, capturedImage: null });
      }

      // Find connected generate3d node via edges (edge targeting this viewer's "3d" handle)
      const incomingEdge = loadedEdges.find(
        (e) => e.target === node.id && e.targetHandle === "3d"
      );
      if (!incomingEdge) continue;

      const sourceNode = loadedNodes.find((n) => n.id === incomingEdge.source);
      if (!sourceNode || sourceNode.type !== "generate3d") continue;

      const gen3dData = sourceNode.data as Generate3DNodeData;
      const remoteUrl = gen3dData.output3dUrl;

      // Only restore from valid remote URLs (not blob URLs)
      if (!remoteUrl || remoteUrl.startsWith("blob:")) continue;

      // Fire-and-forget async restore — doesn't block workflow loading
      (async () => {
        try {
          const response = await fetch("/api/proxy-fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: remoteUrl }),
          });

          if (!response.ok) {
            console.warn(`[3D restore] Failed to fetch ${remoteUrl}: HTTP ${response.status}`);
            return;
          }

          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          const filename = gen3dData.savedFilename || "restored.glb";

          get().updateNodeData(node.id, {
            glbUrl: blobUrl,
            filename,
            capturedImage: null,
          });
          console.log(`[3D restore] Restored ${filename} in GLB viewer ${node.id}`);
        } catch (err) {
          console.warn(`[3D restore] Failed to restore 3D model for viewer ${node.id}:`, err);
        }
      })();
    }

    // Clear snapshot unless explicitly preserving (e.g., AI workflow generation)
    if (!options?.preserveSnapshot) {
      get().clearSnapshot();
    }

    // Recompute dimming after loading workflow
    get().recomputeDimmedNodes();
  },

  importWorkflow: (workflow: WorkflowFile, dropPosition?: { x: number; y: number }) => {
    const { nodes: existingNodes, edges: existingEdges } = get();

    // 1. Build ID remap: increment counter for each imported node to avoid collisions
    const idMap = new Map<string, string>();
    for (const node of workflow.nodes) {
      const newId = `${node.type}-${++nodeIdCounter}`;
      idMap.set(node.id, newId);
    }

    // 2. Calculate offset to position imported nodes
    const NODE_W = 300; // estimated node width
    const NODE_H = 280; // estimated node height
    const GAP = 50;     // gap between node groups

    // Compute the bounding box of the imported subgraph
    const importMinX = Math.min(...workflow.nodes.map((n) => n.position.x));
    const importMinY = Math.min(...workflow.nodes.map((n) => n.position.y));
    const importMaxX = Math.max(...workflow.nodes.map((n) => n.position.x + NODE_W));
    const importMaxY = Math.max(...workflow.nodes.map((n) => n.position.y + NODE_H));
    const importW = importMaxX - importMinX;
    const importH = importMaxY - importMinY;

    let offsetX: number;
    let offsetY: number;

    if (dropPosition) {
      // Center the imported subgraph on the drop position
      offsetX = dropPosition.x - importMinX - importW / 2;
      offsetY = dropPosition.y - importMinY - importH / 2;

      // Check for overlap with existing nodes and nudge right if needed
      if (existingNodes.length > 0) {
        const placedMinX = () => importMinX + offsetX;
        const placedMaxX = () => importMaxX + offsetX;
        const placedMinY = importMinY + offsetY;
        const placedMaxY = importMaxY + offsetY;

        // Keep nudging right until no existing node overlaps
        let hasOverlap = true;
        while (hasOverlap) {
          hasOverlap = false;
          for (const en of existingNodes) {
            const enW = (en.measured?.width as number) || (en.style?.width as number) || NODE_W;
            const enH = (en.measured?.height as number) || (en.style?.height as number) || NODE_H;
            const enMaxX = en.position.x + enW;
            const enMaxY = en.position.y + enH;

            // Check AABB overlap
            if (
              placedMinX() < enMaxX + GAP &&
              placedMaxX() > en.position.x - GAP &&
              placedMinY < enMaxY + GAP &&
              placedMaxY > en.position.y - GAP
            ) {
              // Nudge right past this node
              offsetX = enMaxX + GAP - importMinX;
              hasOverlap = true;
              break; // restart overlap check with new position
            }
          }
        }
      }
    } else {
      // No drop position — place to the right of existing content (legacy behavior)
      offsetX = 200;
      offsetY = 0;
      if (existingNodes.length > 0) {
        const maxX = Math.max(...existingNodes.map((n) => n.position.x + NODE_W));
        const minY = Math.min(...existingNodes.map((n) => n.position.y));
        offsetX = maxX + GAP + GAP - importMinX;
        offsetY = minY - importMinY;
      }
    }

    // 3. Remap node IDs and offset positions
    const newNodes: WorkflowNode[] = workflow.nodes.map((node) => ({
      ...structuredClone(node),
      id: idMap.get(node.id) || node.id,
      position: {
        x: node.position.x + offsetX,
        y: node.position.y + offsetY,
      },
      selected: false,
    }));

    // 4. Migrate legacy handle IDs before remapping: output nodes' typed
    // handles → "universal", and generator nodes' indexed "image-0"/"text-0"
    // → bare handles (imported files can predate both conventions).
    const outputNodeIds = new Set(
      workflow.nodes.filter((n) => n.type === "output").map((n) => n.id)
    );
    workflow.edges = workflow.edges.map((edge) => {
      if (!outputNodeIds.has(edge.target)) return edge;
      const th = edge.targetHandle;
      if (th === "image" || th === "audio" || th === "3d") {
        return { ...edge, targetHandle: "universal" };
      }
      return edge;
    });
    workflow.edges = sweepGhostEdges(
      workflow.nodes,
      migrateLegacyIndexedHandles(workflow.nodes, workflow.edges)
    );

    // 5. Remap edge source/target IDs
    const newEdges: WorkflowEdge[] = workflow.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((edge, idx) => ({
        ...edge,
        id: `e-${idMap.get(edge.source)}-${idMap.get(edge.target)}-${Date.now()}-${idx}`,
        source: idMap.get(edge.source) || edge.source,
        target: idMap.get(edge.target) || edge.target,
      }));

    // 5. Merge into existing workflow
    set({
      nodes: [...existingNodes, ...newNodes],
      edges: [...existingEdges, ...newEdges],
      hasUnsavedChanges: true,
    });

    // Recompute dimming
    get().recomputeDimmedNodes();

    // 6. Post-import: extract embedded base64 content to generations folder (async, non-blocking)
    const generationsPath = get().generationsPath;
    if (generationsPath) {
      const extractContent = async () => {
        for (const node of newNodes) {
          const d = node.data as Record<string, unknown>;
          const nodeType = node.type;

          // Collect base64 data URLs to save: { field, content, prompt? }
          const toSave: Array<{ field: string; content: string; prompt?: string }> = [];

          if (nodeType === "nanoBanana" && typeof d.outputImage === "string" && (d.outputImage as string).startsWith("data:")) {
            toSave.push({ field: "outputImage", content: d.outputImage as string, prompt: d.inputPrompt as string });
          }
          if (nodeType === "generateVideo" && typeof d.outputVideo === "string" && (d.outputVideo as string).startsWith("data:")) {
            toSave.push({ field: "outputVideo", content: d.outputVideo as string, prompt: d.inputPrompt as string });
          }
          if (nodeType === "generateAudio" && typeof d.outputAudio === "string" && (d.outputAudio as string).startsWith("data:")) {
            toSave.push({ field: "outputAudio", content: d.outputAudio as string, prompt: d.inputPrompt as string });
          }
          if (nodeType === "imageInput" && typeof d.image === "string" && (d.image as string).startsWith("data:")) {
            toSave.push({ field: "image", content: d.image as string });
          }

          for (const item of toSave) {
            try {
              const isVideo = item.content.startsWith("data:video/");
              const isAudio = item.content.startsWith("data:audio/");
              const savePayload: Record<string, unknown> = {
                directoryPath: generationsPath,
                prompt: item.prompt || "",
                imageId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              };
              if (isVideo) {
                savePayload.video = item.content;
              } else if (isAudio) {
                // Audio — save as image field (the API handles all media types)
                savePayload.image = item.content;
              } else {
                savePayload.image = item.content;
              }

              await fetch("/api/save-generation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(savePayload),
              });
            } catch (err) {
              console.warn("Failed to extract imported content:", err);
            }
          }
        }
      };

      // Fire and forget — don't block the import
      extractContent().catch((err) => console.warn("Import content extraction failed:", err));
    }
  },

  clearWorkflow: () => {
    set({
      nodes: [],
      edges: [],
      groups: {},
      isRunning: false,
      currentNodeIds: [],
      // Reset auto-save state when clearing workflow
      workflowId: null,
      workflowName: null,
      saveDirectoryPath: null,
      generationsPath: null,
      lastSavedAt: null,
      hasUnsavedChanges: false,
      // Reset cost tracking
      incurredCost: 0,
      // Reset imageRef tracking
      imageRefBasePath: null,
      // Reset viewed comments when clearing workflow
      viewedCommentNodeIds: new Set<string>(),
      // Reset dimmed nodes
      dimmedNodeIds: new Set<string>(),
      // Clear undo/redo stacks
      undoStack: [],
      redoStack: [],
      _lastSnapshotTime: 0,
    });
    deletedNodesCache.clear();
    pendingImageSyncs.clear();
    get().clearSnapshot();
  },

  addToGlobalHistory: (item: Omit<ImageHistoryItem, "id">) => {
    const newItem: ImageHistoryItem = {
      ...item,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    set((state) => ({
      globalImageHistory: [newItem, ...state.globalImageHistory].slice(0, 200),
    }));
  },

  clearGlobalHistory: () => {
    set({ globalImageHistory: [] });
  },

  // Auto-save actions
  setWorkflowMetadata: (id: string, name: string, path: string, generationsPath?: string | null) => {
    // Auto-derive generationsPath: use provided value, or derive from the new project path.
    // Do NOT fall back to the old stored value — when the user changes the project directory,
    // generationsPath must follow it.
    // Normalize backslashes to forward slashes for consistency (UNC paths with / work on all platforms)
    const normalizedPath = path.replace(/\\/g, "/");
    const derivedGenerationsPath = generationsPath ?? `${normalizedPath}/generations`;

    set({
      workflowId: id,
      workflowName: name,
      saveDirectoryPath: path,
      generationsPath: derivedGenerationsPath,
    });
  },

  setWorkflowName: (name: string) => {
    set({
      workflowName: name,
      hasUnsavedChanges: true,
    });
  },

  setGenerationsPath: (path: string | null) => {
    set({
      generationsPath: path,
    });
  },

  setAutoSaveEnabled: (enabled: boolean) => {
    set({ autoSaveEnabled: enabled });
  },

  setUseExternalImageStorage: (enabled: boolean) => {
    set({ useExternalImageStorage: enabled });
  },

  markAsUnsaved: () => {
    set({ hasUnsavedChanges: true });
  },

  saveToFile: async (opts?: { allowEmpty?: boolean }) => {
    let {
      nodes,
      edges,
      edgeStyle,
      groups,
      workflowId,
      workflowName,
      saveDirectoryPath,
      useExternalImageStorage,
      imageRefBasePath,
    } = get();

    if (!workflowId || !workflowName || !saveDirectoryPath) {
      return false;
    }

    set({ isSaving: true });

    try {
      // Wait for any pending image/video saves to complete so their IDs are synced
      // This prevents saving workflows with temporary IDs that don't match saved files
      await waitForPendingImageSyncs();

      // Re-fetch nodes after waiting, as imageHistory IDs may have been updated
      let currentNodes = get().nodes;

      // Check if any nodes have existing image refs
      // This helps detect "save to new directory" when imageRefBasePath wasn't set
      // (e.g., workflow loaded from file dialog without directory context)
      const hasExistingRefs = currentNodes.some(node => {
        const data = node.data as Record<string, unknown>;
        return data.imageRef || data.outputImageRef || data.sourceImageRef || data.inputImageRefs;
      });

      // If saving to a different directory than where refs point, clear refs
      // so images will be re-saved to the new location
      const isNewDirectory = useExternalImageStorage && (
        // Case 1: Known different directory
        (imageRefBasePath !== null && imageRefBasePath !== saveDirectoryPath) ||
        // Case 2: Has refs but unknown where they came from - treat as new directory to be safe
        (imageRefBasePath === null && hasExistingRefs)
      );

      // A copied template keeps the original's baked-in workflow id, so its
      // localStorage config (paths, cost, settings) collides with every sibling
      // copy. Detect that: a saved config exists for this id but is registered
      // to a DIFFERENT directory than where we're saving now. (Empty templates
      // have no image refs, so the ref-based check above misses them.)
      const normalizeDir = (p: string | null | undefined) =>
        (p ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "");
      const existingConfigForId = loadSaveConfigs()[workflowId];
      const idRegisteredToOtherDir =
        !!existingConfigForId?.directoryPath &&
        normalizeDir(existingConfigForId.directoryPath) !== normalizeDir(saveDirectoryPath);

      if (isNewDirectory || idRegisteredToOtherDir) {
        // Give the copy its own id so its config is independent of the original
        // (otherwise they'd share one generations path, cost tally, etc.).
        const newWorkflowId = generateWorkflowId();
        workflowId = newWorkflowId;

        // Only clear refs when the images genuinely came from another directory.
        // A config-only mismatch must NOT discard refs that already point at
        // this folder (that would needlessly re-save the images).
        if (isNewDirectory) {
          currentNodes = clearNodeImageRefs(currentNodes);
        }
        set({
          nodes: currentNodes,
          workflowId: newWorkflowId,
        });
      }

      let workflow: WorkflowFile = {
        version: 1,
        id: workflowId,
        name: workflowName,
        nodes: currentNodes,
        edges,
        edgeStyle,
        groups: groups && Object.keys(groups).length > 0 ? groups : undefined,
      };

      // If external image storage is enabled, externalize images before saving
      if (useExternalImageStorage) {
        workflow = await externalizeWorkflowImages(workflow, saveDirectoryPath);
      }

      const response = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: saveDirectoryPath,
          filename: workflowName,
          workflow,
          allowEmpty: opts?.allowEmpty === true,
        }),
      });

      const result = await response.json();

      if (result.success) {
        const timestamp = Date.now();

        // If we externalized images, update store nodes with the refs
        // This prevents duplicate images on subsequent saves
        if (useExternalImageStorage && workflow.nodes !== currentNodes) {
          // Merge refs from externalized nodes into LATEST store nodes (not the stale
          // snapshot captured at save start). This prevents the async save from
          // overwriting node data that was updated while externalization was in progress
          // (e.g. a video generation completing during save).
          const latestNodes = get().nodes;
          const nodesWithRefs = latestNodes.map((node) => {
            // Find the matching externalized node by ID (not index — nodes may have been
            // added/removed during the async save)
            const externalizedNode = workflow.nodes.find((en) => en.id === node.id);
            if (!externalizedNode) {
              return node; // Node was added after save started — keep as-is
            }

            // Copy refs from externalized node while keeping current image data
            // Use type assertion to access ref fields that may exist on various node types
            const mergedData = { ...node.data } as Record<string, unknown>;
            const extData = externalizedNode.data as Record<string, unknown>;

            // Copy ref fields based on node type
            if (extData.imageRef && typeof extData.imageRef === 'string') {
              mergedData.imageRef = extData.imageRef;
            }
            if (extData.sourceImageRef && typeof extData.sourceImageRef === 'string') {
              mergedData.sourceImageRef = extData.sourceImageRef;
            }
            if (extData.outputImageRef && typeof extData.outputImageRef === 'string') {
              mergedData.outputImageRef = extData.outputImageRef;
            }
            if (extData.inputImageRefs && Array.isArray(extData.inputImageRefs)) {
              mergedData.inputImageRefs = extData.inputImageRefs;
            }
            // GLB file ref (created during externalization fallback for glbViewer nodes)
            if (extData.glbFileRef && typeof extData.glbFileRef === 'string') {
              mergedData.glbFileRef = extData.glbFileRef;
            }
            // Video refs (generateVideo nodes)
            if (extData.outputVideoRef && typeof extData.outputVideoRef === 'string') {
              mergedData.outputVideoRef = extData.outputVideoRef;
            }
            if (extData.thumbnailImageRef && typeof extData.thumbnailImageRef === 'string') {
              mergedData.thumbnailImageRef = extData.thumbnailImageRef;
            }
            // Audio ref (generateAudio nodes)
            if (extData.outputAudioRef && typeof extData.outputAudioRef === 'string') {
              mergedData.outputAudioRef = extData.outputAudioRef;
            }

            return { ...node, data: mergedData as WorkflowNodeData } as WorkflowNode;
          });

          set({
            nodes: nodesWithRefs,
            lastSavedAt: timestamp,
            hasUnsavedChanges: false,
            // Update imageRefBasePath to reflect new save location
            imageRefBasePath: saveDirectoryPath,
          });
        } else {
          set({
            lastSavedAt: timestamp,
            hasUnsavedChanges: false,
            // Update imageRefBasePath to reflect save location
            imageRefBasePath: useExternalImageStorage ? saveDirectoryPath : null,
          });
        }

        // Update localStorage
        saveSaveConfig({
          workflowId,
          name: workflowName,
          directoryPath: saveDirectoryPath,
          generationsPath: get().generationsPath,
          lastSavedAt: timestamp,
          useExternalImageStorage,
        });

        return true;
      } else if (result.code === "empty_save_refused") {
        // The server declined to blank an existing workflow. That is the guard
        // doing its job, not a failure — say so plainly and leave the file
        // alone. hasUnsavedChanges stays true, so the real graph still gets
        // written the moment there is one.
        console.warn("[save] server refused an empty save over an existing workflow");
        useToast
          .getState()
          .show("Skipped saving an empty workflow over the existing file.", "info");
        return false;
      } else {
        useToast.getState().show(`Auto-save failed: ${result.error}`, "error");
        return false;
      }
    } catch (error) {
      // Deliberately loud: capacity errors ("Invalid array length" /
      // "Invalid string length") mean some node field holds gigantic inline
      // data — the stack pinpoints which serialization step blew up.
      console.error("[auto-save] failed:", error instanceof Error ? error.stack || error.message : error);
      useToast
        .getState()
        .show(
          `Auto-save failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "error"
        );
      return false;
    } finally {
      set({ isSaving: false });
    }
  },

  saveAsFile: async (name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return false;
    }

    const { saveDirectoryPath, workflowId: prevId, workflowName: prevName, hasUnsavedChanges: prevUnsaved } = get();
    if (!saveDirectoryPath) {
      return false;
    }

    // Save As creates another workflow JSON in the same project folder.
    const newWorkflowId = generateWorkflowId();
    set({
      workflowId: newWorkflowId,
      workflowName: trimmedName,
      hasUnsavedChanges: true,
    });

    const success = await get().saveToFile({ allowEmpty: true });
    if (!success) {
      // Rollback to previous identity on failure
      set({ workflowId: prevId, workflowName: prevName, hasUnsavedChanges: prevUnsaved });
    }
    return success;
  },

  initializeAutoSave: () => {
    if (autoSaveIntervalId) return;

    autoSaveIntervalId = setInterval(async () => {
      const state = get();
      // NEVER autosave an empty canvas. A blank graph that still pointed at a
      // loaded project is exactly how a real workflow got overwritten with
      // `{"nodes":[],"edges":[]}`, and 90s later the .bak went the same way.
      // Deleting every node on purpose is still saveable — by hand, which is
      // the only context where "yes, really, save nothing" is a statement of
      // intent rather than an accident of timing. The server refuses this too
      // (POST /api/workflow), so both app instances are covered; this just
      // stops the pointless request.
      if (state.nodes.length === 0) return;
      if (
        state.autoSaveEnabled &&
        state.hasUnsavedChanges &&
        state.workflowId &&
        state.workflowName &&
        state.saveDirectoryPath &&
        !state.isSaving
      ) {
        await state.saveToFile();
      }
    }, AUTO_SAVE_INTERVAL_MS);
  },

  cleanupAutoSave: () => {
    if (autoSaveIntervalId) {
      clearInterval(autoSaveIntervalId);
      autoSaveIntervalId = null;
    }
  },

  // Cost tracking actions
  addIncurredCost: (cost: number) => {
    set((state) => ({ incurredCost: state.incurredCost + cost }));
    get().saveIncurredCost();
  },

  resetIncurredCost: () => {
    set({ incurredCost: 0 });
    get().saveIncurredCost();
  },

  loadIncurredCost: (workflowId: string) => {
    const data = loadWorkflowCostData(workflowId);
    set({ incurredCost: data?.incurredCost || 0 });
  },

  saveIncurredCost: () => {
    const { workflowId, incurredCost } = get();
    if (!workflowId) return;
    saveWorkflowCostData({
      workflowId,
      incurredCost,
      lastUpdated: Date.now(),
    });
  },

  // Provider settings actions
  updateProviderSettings: (settings: ProviderSettings) => {
    set({ providerSettings: settings });
    saveProviderSettings(settings);
  },

  updateProviderApiKey: (providerId: ProviderType, apiKey: string | null) => {
    const { providerSettings } = get();
    const updated: ProviderSettings = {
      providers: {
        ...providerSettings.providers,
        [providerId]: {
          ...providerSettings.providers[providerId],
          apiKey,
        },
      },
    };
    set({ providerSettings: updated });
    saveProviderSettings(updated);
  },

  toggleProvider: (providerId: ProviderType, enabled: boolean) => {
    const { providerSettings } = get();
    const updated: ProviderSettings = {
      providers: {
        ...providerSettings.providers,
        [providerId]: {
          ...providerSettings.providers[providerId],
          enabled,
        },
      },
    };
    set({ providerSettings: updated });
    saveProviderSettings(updated);
  },

  // Keyboard shortcuts dialog actions
  setShortcutsDialogOpen: (open: boolean) => {
    set({ shortcutsDialogOpen: open });
  },

  // Model search dialog actions
  setModelSearchOpen: (open: boolean, provider?: ProviderType | null) => {
    set({
      modelSearchOpen: open,
      modelSearchProvider: provider ?? null,
    });
  },

  trackModelUsage: (model: { provider: ProviderType; modelId: string; displayName: string }) => {
    const current = get().recentModels;
    // Remove existing entry for same modelId if present
    const filtered = current.filter((m) => m.modelId !== model.modelId);
    // Prepend new entry with current timestamp
    const updated: RecentModel[] = [
      {
        provider: model.provider,
        modelId: model.modelId,
        displayName: model.displayName,
        timestamp: Date.now(),
      },
      ...filtered,
    ].slice(0, MAX_RECENT_MODELS);
    // Save to localStorage and update state
    saveRecentModels(updated);
    set({ recentModels: updated });
  },

  // Comment navigation actions
  getNodesWithComments: () => {
    const { nodes } = get();
    // Filter nodes that have comments
    const nodesWithComments = nodes.filter((node) => {
      const data = node.data as { comment?: string };
      return data.comment && data.comment.trim().length > 0;
    });

    // Sort by position: top-to-bottom (Y), then left-to-right (X)
    // Use 50px threshold for row grouping
    const ROW_THRESHOLD = 50;
    return nodesWithComments.sort((a, b) => {
      // Check if nodes are in the same "row" (within threshold)
      const yDiff = a.position.y - b.position.y;
      if (Math.abs(yDiff) <= ROW_THRESHOLD) {
        // Same row, sort by X position
        return a.position.x - b.position.x;
      }
      // Different rows, sort by Y position
      return yDiff;
    });
  },

  getUnviewedCommentCount: () => {
    const { viewedCommentNodeIds } = get();
    const nodesWithComments = get().getNodesWithComments();
    return nodesWithComments.filter((node) => !viewedCommentNodeIds.has(node.id)).length;
  },

  markCommentViewed: (nodeId: string) => {
    set((state) => {
      const newViewedSet = new Set(state.viewedCommentNodeIds);
      newViewedSet.add(nodeId);
      return { viewedCommentNodeIds: newViewedSet };
    });
  },

  setNavigationTarget: (nodeId: string | null) => {
    if (nodeId === null) {
      set({ navigationTarget: null });
    } else {
      // Use timestamp to ensure each navigation triggers a new effect even if same node
      set({ navigationTarget: { nodeId, timestamp: Date.now() } });
      // Also focus the comment tooltip on the target node
      set({ focusedCommentNodeId: nodeId });
    }
  },

  setFocusedCommentNodeId: (nodeId: string | null) => {
    set({ focusedCommentNodeId: nodeId });
  },

  resetViewedComments: () => {
    set({ viewedCommentNodeIds: new Set<string>() });
  },

  // AI change snapshot actions
  captureSnapshot: () => {
    const state = get();
    // Deep copy the current workflow state to avoid reference sharing
    const snapshot = {
      nodes: JSON.parse(JSON.stringify(state.nodes)),
      edges: JSON.parse(JSON.stringify(state.edges)),
      groups: JSON.parse(JSON.stringify(state.groups)),
      edgeStyle: state.edgeStyle,
    };
    set({
      previousWorkflowSnapshot: snapshot,
      manualChangeCount: 0,
    });
  },

  revertToSnapshot: () => {
    const state = get();
    if (state.previousWorkflowSnapshot) {
      set({
        nodes: state.previousWorkflowSnapshot.nodes,
        edges: state.previousWorkflowSnapshot.edges,
        groups: state.previousWorkflowSnapshot.groups,
        edgeStyle: state.previousWorkflowSnapshot.edgeStyle,
        previousWorkflowSnapshot: null,
        manualChangeCount: 0,
        hasUnsavedChanges: true,
      });
    }
  },

  clearSnapshot: () => {
    set({
      previousWorkflowSnapshot: null,
      manualChangeCount: 0,
    });
  },

  incrementManualChangeCount: () => {
    const state = get();
    const newCount = state.manualChangeCount + 1;

    // Automatically clear snapshot after 3 manual changes
    if (newCount >= 3) {
      set({
        previousWorkflowSnapshot: null,
        manualChangeCount: 0,
      });
    } else {
      set({ manualChangeCount: newCount });
    }
  },

  // ─── Undo/Redo ─────────────────────────────────────────────────

  pushUndoSnapshot: () => {
    const now = Date.now();
    const state = get();
    // Debounce: skip if too recent (e.g., rapid node dragging)
    if (now - state._lastSnapshotTime < UNDO_DEBOUNCE_MS) return;
    // Don't snapshot during execution
    if (state.isRunning) return;

    try {
      // Create minimal snapshot — only positions + small user-editable fields
      const minimalNodes = state.nodes.map(snapshotNode);
      const snapshot: WorkflowSnapshot = {
        nodes: JSON.parse(JSON.stringify(minimalNodes)),
        edges: JSON.parse(JSON.stringify(state.edges)),
        groups: JSON.parse(JSON.stringify(state.groups)),
        edgeStyle: state.edgeStyle,
      };

      const stack = [...state.undoStack, snapshot];
      if (stack.length > UNDO_STACK_MAX) stack.shift();

      set({
        undoStack: stack,
        redoStack: [],
        _lastSnapshotTime: now,
      });
    } catch (e) {
      // If serialization fails (e.g., too large), silently skip this snapshot
      console.warn("[undo] Snapshot skipped — serialization failed:", e);
    }
  },

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) return;
    if (state.isRunning) return;

    // Save current state to redo stack (minimal)
    const lightNodes = state.nodes.map(snapshotNode);
    const current: WorkflowSnapshot = {
      nodes: JSON.parse(JSON.stringify(lightNodes)),
      edges: JSON.parse(JSON.stringify(state.edges)),
      groups: JSON.parse(JSON.stringify(state.groups)),
      edgeStyle: state.edgeStyle,
    };

    const newUndoStack = [...state.undoStack];
    const restored = newUndoStack.pop()!;

    // Merge back large data from current nodes
    const mergedNodes = mergeSnapshotWithLive(restored.nodes, state.nodes);

    set({
      nodes: mergedNodes,
      edges: restored.edges,
      groups: restored.groups,
      edgeStyle: restored.edgeStyle,
      undoStack: newUndoStack,
      redoStack: [...state.redoStack, current],
      hasUnsavedChanges: true,
      _lastSnapshotTime: Date.now(),
    });
  },

  redo: () => {
    const state = get();
    if (state.redoStack.length === 0) return;
    if (state.isRunning) return;

    const lightNodes = state.nodes.map(snapshotNode);
    const current: WorkflowSnapshot = {
      nodes: JSON.parse(JSON.stringify(lightNodes)),
      edges: JSON.parse(JSON.stringify(state.edges)),
      groups: JSON.parse(JSON.stringify(state.groups)),
      edgeStyle: state.edgeStyle,
    };

    const newRedoStack = [...state.redoStack];
    const restored = newRedoStack.pop()!;

    const mergedNodes = mergeSnapshotWithLive(restored.nodes, state.nodes);

    set({
      nodes: mergedNodes,
      edges: restored.edges,
      groups: restored.groups,
      edgeStyle: restored.edgeStyle,
      undoStack: [...state.undoStack, current],
      redoStack: newRedoStack,
      hasUnsavedChanges: true,
      _lastSnapshotTime: Date.now(),
    });
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  applyEditOperations: (operations) => {
    const state = get();
    const result = executeEditOps(operations, {
      nodes: state.nodes,
      edges: state.edges,
    });

    set({
      nodes: result.nodes,
      edges: result.edges,
      hasUnsavedChanges: true,
    });

    return { applied: result.applied, skipped: result.skipped };
  },

  // Canvas navigation settings actions
  updateCanvasNavigationSettings: (settings: CanvasNavigationSettings) => {
    set({ canvasNavigationSettings: settings });
    saveCanvasNavigationSettings(settings);
  },

  // Switch dimming actions
  recomputeDimmedNodes: () => {
    const { nodes, edges } = get();
    const newDimmed = computeDimmedNodes(nodes, edges);
    // Only update if set contents changed (prevent unnecessary rerenders)
    const currentDimmed = get().dimmedNodeIds;
    if (newDimmed.size !== currentDimmed.size ||
        [...newDimmed].some(id => !currentDimmed.has(id))) {
      set({ dimmedNodeIds: newDimmed });
    }
  },

});

export const useWorkflowStore = create<WorkflowStore>()(workflowStoreImpl);

/**
 * Stable hook for provider API keys.
 *
 * Returns individual primitive values for each provider's API key.
 * Uses shallow equality comparison to prevent re-renders when the
 * providerSettings object reference changes but the actual key values
 * don't change.
 *
 * This prevents unnecessary re-fetches of /api/models when multiple
 * node instances subscribe to provider settings.
 */
export function useProviderApiKeys() {
  return useWorkflowStore(
    useShallow((state) => ({
      geminiApiKey: state.providerSettings.providers.gemini?.apiKey ?? null,
      replicateApiKey: state.providerSettings.providers.replicate?.apiKey ?? null,
      falApiKey: state.providerSettings.providers.fal?.apiKey ?? null,
      kieApiKey: state.providerSettings.providers.kie?.apiKey ?? null,
      wavespeedApiKey: state.providerSettings.providers.wavespeed?.apiKey ?? null,
      muapiApiKey: state.providerSettings.providers.muapi?.apiKey ?? null,
      // Provider enabled states (for conditional UI)
      replicateEnabled: state.providerSettings.providers.replicate?.enabled ?? false,
      kieEnabled: state.providerSettings.providers.kie?.enabled ?? false,
    }))
  );
}
