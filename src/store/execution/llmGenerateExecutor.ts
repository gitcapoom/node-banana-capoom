/**
 * LLM Generate Executor
 *
 * Unified executor for llmGenerate (text generation) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { LLMGenerateNodeData, ConversationTurn } from "@/types";
import { buildLlmHeaders } from "@/store/utils/buildApiHeaders";
import type { NodeExecutionContext } from "./types";
import { loadMediaById } from "@/utils/mediaStorage";

export interface LlmGenerateOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}


export async function executeLlmGenerate(
  ctx: NodeExecutionContext,
  options: LlmGenerateOptions = {}
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    signal,
    providerSettings,
    saveDirectoryPath,
  } = ctx;

  const { useStoredFallback = false } = options;

  const inputs = getConnectedInputs(node.id);
  const nodeData = node.data as LLMGenerateNodeData;

  // Determine images and text
  let images: string[];
  let text: string | null;

  // The compose box is how the node is driven. It wins over everything else
  // because it is the most recent deliberate act; `inputs.text` remains as a
  // fallback for workflows still wired through the (now removed) text input,
  // and the stored inputPrompt behind that for a re-run with no new message.
  const composed = (nodeData.composeInput ?? "").trim();
  if (useStoredFallback) {
    images = inputs.images.length > 0 ? inputs.images : nodeData.inputImages;
  } else {
    images = inputs.images;
  }
  text = composed || inputs.text || nodeData.inputPrompt;

  // Defensive validation — the image-handle on this node accepts any edge
  // (React Flow doesn't strictly type-check connections), so a text-typed
  // source wired to it would land its prose into `images` and the
  // provider would reject the request with a cryptic "Invalid image".
  // Filter to entries that actually look like image URLs; warn the user
  // (via the node error) if any were dropped so they can fix their wiring.
  const isLikelyImageUrl = (s: unknown): s is string => {
    if (typeof s !== "string" || s.length === 0) return false;
    if (s.startsWith("data:image/")) return true;
    if (s.startsWith("http://") || s.startsWith("https://")) return true;
    if (s.startsWith("blob:")) return true;
    return false;
  };
  const rawImageCount = images.length;
  images = images.filter(isLikelyImageUrl);
  const droppedCount = rawImageCount - images.length;

  // Video inputs (Gemini models only — the route rejects other providers with
  // a clear error). blob: URLs only exist in this browser session, so convert
  // them to data URLs before they cross to the server.
  let videos: string[] = [];
  for (const vid of inputs.videos) {
    if (typeof vid !== "string" || vid.length === 0) continue;
    if (vid.startsWith("blob:")) {
      try {
        const blob = await fetch(vid).then((r) => r.blob());
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read video blob"));
          reader.readAsDataURL(blob);
        });
        videos.push(dataUrl);
      } catch (err) {
        console.warn(`[llmGenerateExecutor] Could not read video blob URL:`, err);
      }
    } else if (vid.startsWith("data:video/") || vid.startsWith("http://") || vid.startsWith("https://")) {
      videos.push(vid);
    }
  }

  if (!text) {
    updateNodeData(node.id, {
      status: "error",
      error: droppedCount > 0
        ? `Image input is wired to a non-image source (${droppedCount} dropped). Connect an image-typed output (Image Input, Generate Image, Crop, etc.) to the image handle, or remove the bad edge.`
        : "Nothing to send — type a message in the box below and press Send.",
    });
    throw new Error("Missing text input");
  }
  if (droppedCount > 0) {
    console.warn(
      `[llmGenerateExecutor] Dropped ${droppedCount} non-image value(s) from the image input ` +
      `(text was wired to the image handle?). Sent ${images.length} valid image(s).`,
    );
  }

  // Build the new user turn. In one-shot mode this becomes the only
  // turn the API sees; in conversation mode it gets appended to the
  // saved transcript before sending.
  const newUserTurn: ConversationTurn = {
    role: "user",
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(videos.length > 0 ? { videos } : {}),
    timestamp: Date.now(),
  };

  const useConversation = nodeData.rememberTurns === true;
  const priorConversation = nodeData.conversation ?? [];

  // Apply the max-turns cap. A "turn" is one user+assistant pair, so
  // we keep the last (2 * maxHistoryTurns) entries plus the new user
  // turn. 0 / undefined / negative = unlimited.
  const cap = nodeData.maxHistoryTurns ?? 0;
  const slicedPrior = cap > 0
    ? priorConversation.slice(Math.max(0, priorConversation.length - cap * 2))
    : priorConversation;

  // Transcript images live on disk as refs after a save (see imageStorage), so
  // hydrate the turns actually being sent — otherwise a reloaded conversation
  // would quietly go text-only. Only the sliced window is loaded, never the
  // whole history.
  let historyToSend: ConversationTurn[] = slicedPrior;
  if (saveDirectoryPath) {
    historyToSend = await Promise.all(
      slicedPrior.map(async (turn) => {
        if (turn.images?.length || !turn.imageRefs?.length) return turn;
        const loaded = await Promise.all(
          turn.imageRefs.map((ref) =>
            ref ? loadMediaById(ref, saveDirectoryPath, "inputs").catch(() => null) : null,
          ),
        );
        const images = loaded.filter((u): u is string => !!u);
        return images.length ? { ...turn, images } : turn;
      }),
    );
  }

  const outboundMessages: ConversationTurn[] = useConversation
    ? [...historyToSend, newUserTurn]
    : [newUserTurn];

  // In conversation mode, immediately persist the new user turn so the
  // UI's transcript shows it during the loading state. (Assistant turn
  // is appended on success below.)
  const persistedConversation = useConversation
    ? [...priorConversation, newUserTurn]
    : priorConversation;

  updateNodeData(node.id, {
    inputPrompt: text,
    inputImages: images,
    ...(useConversation ? { conversation: persistedConversation } : {}),
    status: "loading",
    loadingStartedAt: Date.now(),
    loadingPhase: "Submitting…",
    error: null,
    lastGenerationCost: null,
  });

  const headers = buildLlmHeaders(nodeData.provider, providerSettings);

  const effectiveSystem = nodeData.systemPrompt;

  try {
    const response = await fetch("/api/llm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: outboundMessages,
        ...(effectiveSystem ? { system: effectiveSystem } : {}),
        provider: nodeData.provider,
        model: nodeData.model,
        temperature: nodeData.temperature,
        maxTokens: nodeData.maxTokens,
        ...(nodeData.reasoning && nodeData.reasoning !== "off" ? { reasoning: nodeData.reasoning } : {}),
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorMessage;
      } catch {
        if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
      }
      updateNodeData(node.id, {
        status: "error",
        error: errorMessage,
        // Roll back the optimistic user turn so the failed prompt isn't
        // permanently in the transcript. User can edit & retry cleanly.
        ...(useConversation ? { conversation: priorConversation } : {}),
      });
      throw new Error(errorMessage);
    }

    const result = await response.json();

    if (result.success && result.text) {
      const assistantTurn: ConversationTurn = {
        role: "assistant",
        text: result.text,
        timestamp: Date.now(),
      };
      updateNodeData(node.id, {
        outputText: result.text,
        ...(useConversation
          ? { conversation: [...persistedConversation, assistantTurn] }
          : {}),
        // Chat-style: clear the compose box after a successful send so the same
        // message is not silently re-sent by the next Run.
        composeInput: "",
        status: "complete",
        error: null,
      });
    } else {
      updateNodeData(node.id, {
        status: "error",
        error: result.error || "LLM generation failed",
      });
      throw new Error(result.error || "LLM generation failed");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    let errorMessage = "LLM generation failed";
    if (error instanceof TypeError && error.message.includes("NetworkError")) {
      errorMessage = "Network error. Check your connection and try again.";
    } else if (error instanceof TypeError) {
      errorMessage = `Network error: ${error.message}`;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      ...(useConversation ? { conversation: priorConversation } : {}),
    });
    throw new Error(errorMessage);
  }
}
