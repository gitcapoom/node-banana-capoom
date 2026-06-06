/**
 * "Split Generation" — turn a generation node's carousel history into one
 * standalone INPUT node per past generation, each populated with that
 * generation's media. Lets you fan a node's accumulated generations out into
 * reusable image/video/audio/3D source nodes.
 *
 * History items store only an `id`; the actual media lives in the generations
 * folder and is loaded on demand via /api/load-generation (same endpoint the
 * carousel uses). For the currently-displayed item we fall back to the inline
 * `output*` data URL if the file can't be read.
 */

import type { NodeType, WorkflowNodeData } from "@/types/nodes";

type Pt = { x: number; y: number };

interface SplitNodeLike {
  id: string;
  type?: string;
  position: Pt;
  data: Record<string, unknown>;
}

interface SplitMapping {
  inputType: NodeType;     // input node type to create
  historyField: string;    // carousel history array on the source node
  selectedField: string;   // index of the currently-shown item
  outputField: string;     // inline data URL for the currently-shown item (fallback)
}

/** Generation node type → how to split it. Only nodes with a real history of
 *  multiple generations are splittable. */
const MAPPINGS: Record<string, SplitMapping> = {
  nanoBanana:    { inputType: "imageInput", historyField: "imageHistory",   selectedField: "selectedHistoryIndex",        outputField: "outputImage" },
  generateVideo: { inputType: "videoInput", historyField: "videoHistory",   selectedField: "selectedVideoHistoryIndex",   outputField: "outputVideo" },
  generateAudio: { inputType: "audioInput", historyField: "audioHistory",   selectedField: "selectedAudioHistoryIndex",   outputField: "outputAudio" },
  generate3d:    { inputType: "glbViewer",  historyField: "model3dHistory", selectedField: "selectedModel3dHistoryIndex", outputField: "output3dUrl" },
};

export function getSplitMapping(nodeType: string | undefined): SplitMapping | null {
  return nodeType ? MAPPINGS[nodeType] ?? null : null;
}

/** Number of generations available to split for a given node. */
export function splitGenerationCount(nodeType: string | undefined, data: Record<string, unknown>): number {
  const m = getSplitMapping(nodeType);
  if (!m) return 0;
  const hist = data[m.historyField];
  return Array.isArray(hist) ? hist.length : 0;
}

interface HistItem { id: string; prompt?: string }

// ── media loading + metadata helpers (browser) ──────────────────────────────

async function loadGenerationUrl(generationsPath: string, id: string): Promise<string | null> {
  try {
    const res = await fetch("/api/load-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryPath: generationsPath, imageId: id }),
    });
    const j = await res.json();
    if (!j?.success) return null;
    return (j.image ?? j.video ?? j.audio ?? j.model3d ?? null) as string | null;
  } catch {
    return null;
  }
}

function mimeOf(dataUrl: string): string | null {
  const m = dataUrl.match(/^data:([^;,]+)[;,]/);
  return m ? m[1] : null;
}

function extOf(mime: string | null, fallback: string): string {
  const sub = mime?.split("/")[1]?.split(";")[0];
  if (!sub) return fallback;
  if (sub === "jpeg") return "jpg";
  if (sub === "gltf-binary") return "glb";
  if (sub === "quicktime") return "mov";
  if (sub === "mpeg") return "mp3";
  return sub;
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function mediaDuration(dataUrl: string, kind: "video" | "audio"): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    el.preload = "metadata";
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => resolve(null);
    el.src = dataUrl;
  });
}

function dataUrlToBlobUrl(dataUrl: string): string | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  try {
    const [, mime, b64] = m;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
}

function slug(s: string | undefined, fallback: string): string {
  const base = (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || fallback;
}

/** Build the input node's data from a loaded generation media URL. */
async function buildInputData(inputType: NodeType, item: HistItem, url: string): Promise<Partial<WorkflowNodeData> | null> {
  const mime = mimeOf(url);
  const name = slug(item.prompt, item.id);
  switch (inputType) {
    case "imageInput": {
      const dimensions = await imageDimensions(url);
      return { image: url, dimensions, filename: `${name}.${extOf(mime, "png")}` } as Partial<WorkflowNodeData>;
    }
    case "videoInput": {
      const duration = await mediaDuration(url, "video");
      return { videoFile: url, duration, format: mime, filename: `${name}.${extOf(mime, "mp4")}` } as Partial<WorkflowNodeData>;
    }
    case "audioInput": {
      const duration = await mediaDuration(url, "audio");
      return { audioFile: url, duration, format: mime, filename: `${name}.${extOf(mime, "mp3")}` } as Partial<WorkflowNodeData>;
    }
    case "glbViewer": {
      // Disk loads arrive as data URLs (convert to a blob URL the viewer wants);
      // the live output may already be a blob:/http URL — use it as-is.
      const glbUrl = url.startsWith("data:") ? dataUrlToBlobUrl(url) : url;
      if (!glbUrl) return null;
      return { glbUrl, filename: `${name}.glb` } as Partial<WorkflowNodeData>;
    }
    default:
      return null;
  }
}

export interface SplitGenerationCtx {
  generationsPath: string | null;
  addNode: (type: NodeType, position: Pt, initialData?: Partial<WorkflowNodeData>) => string;
}

/**
 * Create one input node per generation in the source node's history. Returns
 * how many were created vs the total found. No edges are made — the inputs are
 * standalone sources the user can wire wherever they like.
 */
export async function splitGeneration(node: SplitNodeLike, ctx: SplitGenerationCtx): Promise<{ created: number; total: number }> {
  const m = getSplitMapping(node.type);
  if (!m) return { created: 0, total: 0 };
  const hist = (node.data[m.historyField] as HistItem[] | undefined) ?? [];
  if (hist.length === 0 || !ctx.generationsPath) return { created: 0, total: hist.length };

  const selectedIdx = typeof node.data[m.selectedField] === "number" ? (node.data[m.selectedField] as number) : -1;
  const inlineOutput = typeof node.data[m.outputField] === "string" ? (node.data[m.outputField] as string) : null;

  // Lay the new input nodes out in a grid to the right of the source node.
  const cols = Math.min(hist.length, 4);
  const CELL_W = 320, CELL_H = 300, GAP = 48;
  const startX = node.position.x + 380;
  const startY = node.position.y;

  let created = 0;
  for (let i = 0; i < hist.length; i++) {
    const item = hist[i];
    let url = await loadGenerationUrl(ctx.generationsPath, item.id);
    if (!url && i === selectedIdx && inlineOutput) url = inlineOutput; // the on-screen one
    if (!url) continue;
    const data = await buildInputData(m.inputType, item, url);
    if (!data) continue;
    const col = i % cols, row = Math.floor(i / cols);
    ctx.addNode(m.inputType, { x: startX + col * (CELL_W + GAP), y: startY + row * (CELL_H + GAP) }, data);
    created++;
  }
  return { created, total: hist.length };
}

/**
 * Create a single input node from the generation currently shown on the node.
 * Prefers the inline `output*` data URL (already in memory, so this works even
 * for an unsaved workflow); falls back to loading the selected history item by
 * id. Returns true if a node was created.
 */
export async function splitCurrentGeneration(node: SplitNodeLike, ctx: SplitGenerationCtx): Promise<boolean> {
  const m = getSplitMapping(node.type);
  if (!m) return false;
  const hist = (node.data[m.historyField] as HistItem[] | undefined) ?? [];

  const rawIdx = typeof node.data[m.selectedField] === "number" ? (node.data[m.selectedField] as number) : hist.length - 1;
  const selectedIdx = rawIdx >= 0 && rawIdx < hist.length ? rawIdx : hist.length - 1;
  const item: HistItem = hist[selectedIdx] ?? { id: node.id };

  let url = typeof node.data[m.outputField] === "string" ? (node.data[m.outputField] as string) : null;
  if (!url && ctx.generationsPath && item.id) url = await loadGenerationUrl(ctx.generationsPath, item.id);
  if (!url) return false;

  const data = await buildInputData(m.inputType, item, url);
  if (!data) return false;
  ctx.addNode(m.inputType, { x: node.position.x + 380, y: node.position.y }, data);
  return true;
}
