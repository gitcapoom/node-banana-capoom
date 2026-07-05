/**
 * LLM Generate Executor
 *
 * Unified executor for llmGenerate (text generation) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { LLMGenerateNodeData, ConversationTurn } from "@/types";
import { buildLlmHeaders } from "@/store/utils/buildApiHeaders";
import { LOOPBACK_SKILL, LOOPBACK_SKILL_NAME } from "./loopbackSkill";
import type { NodeExecutionContext } from "./types";

export interface LlmGenerateOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
  /**
   * Loopback action, from the node's two buttons:
   *  - "assess"   → look at the latest generated (feedback) image and critique it.
   *  - "converse" → work off the input prompt only (no image) and refine the prompt.
   * Ignored outside loopback mode. Defaults to "assess".
   */
  loopbackAction?: "assess" | "converse";
}

/**
 * Loopback replies carry two things: the conversational text and a clean image
 * prompt wrapped in <image_prompt>…</image_prompt> (see loopbackSkill.ts). Split
 * them: `prompt` = the block's inner text (feeds the image node); `conversation`
 * = everything else (shown in the transcript). If the skill didn't emit a
 * block, fall back to using the whole reply as the prompt.
 */
export function parseLoopbackReply(raw: string): { conversation: string; prompt: string } {
  const m = raw.match(/<image_prompt>([\s\S]*?)<\/image_prompt>/i);
  if (m && m.index !== undefined) {
    const prompt = m[1].trim();
    const conversation = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
    return { conversation: conversation || "(image prompt updated)", prompt };
  }
  console.warn("[llmGenerateExecutor] Loopback reply had no <image_prompt> block; using the full reply as the prompt.");
  return { conversation: raw.trim(), prompt: raw.trim() };
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
  } = ctx;

  const { useStoredFallback = false } = options;

  const inputs = getConnectedInputs(node.id);
  const nodeData = node.data as LLMGenerateNodeData;

  // Determine images and text
  let images: string[];
  let text: string | null;

  const loopbackMode = nodeData.loopbackMode === true;
  // Loopback exposes two explicit actions (the node's Assess / Converse
  // buttons). Neither generates the image — the user runs the generator node
  // directly. Default to "assess" for any non-button run.
  const loopbackAction: "assess" | "converse" = options.loopbackAction ?? "assess";

  // Loopback only: the full ordered list (feedback first, then live references)
  // that the node's `images` passthrough forwards to the generator. Always
  // stored as inputImages regardless of action, so a text-only Converse turn
  // never strips the generator's references.
  let passthroughList: string[] | null = null;

  if (loopbackMode) {
    // References are LIVE inputs only (not the stored combined list, which would
    // grow every run). Feedback image is Image 1, ahead of the references.
    let refList = [...inputs.images];
    if (inputs.feedbackImage) refList = [inputs.feedbackImage, ...refList];
    passthroughList = refList;

    const goalText = (inputs.text ?? "").trim();
    if (loopbackAction === "converse") {
      // Prompt-focused: no images. Answer the input prompt and refine the output
      // prompt from it + the transcript.
      images = [];
      text = goalText || "Refine the image prompt toward the goal.";
    } else {
      // Assess: the model sees the latest render (Image 1) AND the reference
      // images (Images 2+), plus the input prompt as the goal — so it can judge
      // the render's fidelity to both the goal text and the visual references.
      // (The skill focuses the detailed texture/color critique on Image 1.)
      images = refList;
      if (!inputs.feedbackImage) {
        text = goalText
          ? `There is no generated image yet. Using the reference images as the target, propose an initial image prompt for this goal:\n\n${goalText}`
          : "There is no generated image to assess yet — propose an initial image prompt toward the goal using the reference images.";
      } else {
        text = goalText
          ? `Assess the latest generated image (Image 1) against this goal/direction AND the reference images (Images 2+), then give an improved, corrected prompt:\n\n${goalText}`
          : "Assess the latest generated image (Image 1) against the goal and the reference images (Images 2+), then give an improved, corrected prompt.";
      }
    }
  } else if (useStoredFallback) {
    images = inputs.images.length > 0 ? inputs.images : nodeData.inputImages;
    text = inputs.text ?? nodeData.inputPrompt;
  } else {
    images = inputs.images;
    text = inputs.text ?? nodeData.inputPrompt;
  }

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
  // Keep the passthrough list clean too (it's forwarded to the generator).
  if (passthroughList) passthroughList = passthroughList.filter(isLikelyImageUrl);

  if (!text) {
    updateNodeData(node.id, {
      status: "error",
      error: droppedCount > 0
        ? `Image input is wired to a non-image source (${droppedCount} dropped). Connect an image-typed output (Image Input, Generate Image, Crop, etc.) to the image handle, or remove the bad edge.`
        : "Missing text input - connect a prompt node or set internal prompt",
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
    timestamp: Date.now(),
  };

  const useConversation = nodeData.conversationMode === true;
  const priorConversation = nodeData.conversation ?? [];

  // Apply the max-turns cap. A "turn" is one user+assistant pair, so
  // we keep the last (2 * maxHistoryTurns) entries plus the new user
  // turn. 0 / undefined / negative = unlimited.
  const cap = nodeData.maxHistoryTurns ?? 0;
  const slicedPrior = cap > 0
    ? priorConversation.slice(Math.max(0, priorConversation.length - cap * 2))
    : priorConversation;

  // In loopback mode, send prior turns as text-only so the ONLY images the
  // model sees are the current turn's (feedback = Image 1, then references),
  // keeping the skill's "Image 1 is the feedback" reference unambiguous and
  // saving image tokens. The persisted transcript still keeps its thumbnails.
  let historyToSend = loopbackMode
    ? slicedPrior.map(({ images: _img, ...rest }) => rest)
    : slicedPrior;

  // Loopback: pin the ORIGINAL request (the first user turn) to the front so
  // the compare-to-intent target is never lost when Max-turns truncates older
  // history. Text-only, and only when the cap actually dropped it.
  if (loopbackMode && cap > 0 && priorConversation.length > 0) {
    const original = priorConversation[0];
    const alreadyIncluded = slicedPrior.length > 0 && slicedPrior[0] === original;
    if (!alreadyIncluded) {
      const { images: _origImg, ...originalTextOnly } = original;
      historyToSend = [originalTextOnly, ...historyToSend];
    }
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
    // In loopback, store the full feedback+references list (what the `images`
    // passthrough forwards) rather than just what this turn sent to the LLM —
    // so a text-only Converse turn doesn't blank out the generator's images.
    inputImages: loopbackMode ? (passthroughList ?? []) : images,
    ...(useConversation ? { conversation: persistedConversation } : {}),
    status: "loading",
    loadingStartedAt: Date.now(),
    loadingPhase: "Submitting…",
    error: null,
    lastGenerationCost: null,
  });

  const headers = buildLlmHeaders(nodeData.provider, providerSettings);

  // The built-in loopback skill is the single source of truth: when the node is
  // still using it (promptSkillName marker — cleared the instant the user edits
  // the system prompt), always send the CURRENT skill text, not the copy that
  // was snapshotted into systemPrompt when loopback was first enabled. Without
  // this, skill improvements never reach nodes created before the update unless
  // the user re-toggles the mode. User edits are respected (edit clears the
  // marker, so we fall back to their stored systemPrompt).
  const effectiveSystem =
    loopbackMode && nodeData.promptSkillName === LOOPBACK_SKILL_NAME
      ? LOOPBACK_SKILL
      : nodeData.systemPrompt;

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
      if (loopbackMode) {
        // Two outputs: conversation (transcript + `text` handle) and the clean
        // prompt (`prompt` handle → image node). The transcript stores the
        // conversational text only.
        const { conversation: convoText, prompt } = parseLoopbackReply(result.text);
        const assistantTurn: ConversationTurn = {
          role: "assistant",
          text: convoText,
          timestamp: Date.now(),
        };
        updateNodeData(node.id, {
          outputText: convoText,
          outputPrompt: prompt,
          conversation: [...persistedConversation, assistantTurn],
          status: "complete",
          error: null,
        });
      } else {
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
          status: "complete",
          error: null,
        });
      }
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
