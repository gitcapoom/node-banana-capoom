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
import { loadMediaById } from "@/utils/mediaStorage";

export interface LlmGenerateOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

/**
 * Loopback replies carry two things: the conversational text and a clean image
 * prompt wrapped in <image_prompt>…</image_prompt> (see loopbackSkill.ts). Split
 * them: `prompt` = the block's inner text (feeds the image node); `conversation`
 * = everything else (shown in the transcript). If the skill didn't emit a
 * block, fall back to using the whole reply as the prompt.
 */
export function parseLoopbackReply(raw: string): { conversation: string; prompt: string | null } {
  const m = raw.match(/<image_prompt>([\s\S]*?)<\/image_prompt>/i);
  if (m && m.index !== undefined) {
    const prompt = m[1].trim();
    const conversation = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
    return { conversation: conversation || "(image prompt updated)", prompt: prompt || null };
  }
  // No block — the reply is assessment-only (usually cut off before the prompt,
  // or the model skipped the tags). Do NOT use the assessment AS the prompt:
  // that would feed the critique prose to the image generator. Signal null so
  // the caller keeps the previous prompt instead of clobbering it.
  console.warn("[llmGenerateExecutor] Loopback reply had no <image_prompt> block; keeping the previous prompt.");
  return { conversation: raw.trim(), prompt: null };
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

  const loopbackMode = nodeData.loopbackMode === true;
  // A conversation with no turns yet is "fresh": we ignore any stale feedback
  // image, and (on success) capture this run's prompt as the canonical initial
  // prompt for the conversation.
  const isFreshConversation = (nodeData.conversation ?? []).length === 0;

  // Loopback only: the full ordered list (feedback first, then live references)
  // that the node's `images` passthrough forwards to the generator. Stored as
  // inputImages so the generator always gets the same set the model saw.
  let passthroughList: string[] | null = null;

  if (loopbackMode) {
    // On a FRESH conversation ignore whatever sits on the feedback pin — it's a
    // stale render left over from a previous session or a still-connected
    // generator, NOT this conversation's output. Starting clean means drafting
    // from the goal + references, not "assessing" a stale image.
    const feedbackImage = isFreshConversation ? null : inputs.feedbackImage;

    // DIAGNOSTIC-ONLY render: the references (live inputs) are the ONLY images
    // the generator ever receives (Image 1, 2, …) — that's what the `images`
    // passthrough forwards. The render is NEVER sent to the generator (so there
    // is no sticky-pixel drift anchor); it goes only to the LLM, appended LAST,
    // purely so the LLM can judge what worked / didn't and fold that into the
    // prompt in words. References keep the SAME numbering (Image 1+) whether or
    // not a render exists.
    const references = [...inputs.images];
    passthroughList = references;
    images = feedbackImage ? [...references, feedbackImage] : references;

    // One action ("Send"): fold in the per-turn direction from the in-node
    // compose box (chatbot-style — cleared after each run so the previous prompt
    // can't be silently re-sent), falling back to the connected text input.
    const goalText = (nodeData.composeInput ?? "").trim() || (inputs.text ?? "").trim();
    if (!feedbackImage) {
      text = goalText
        ? `No image has been generated yet. Using the reference images (Image 1+), draft an image prompt for this direction:\n\n${goalText}`
        : "No image has been generated yet — draft an initial image prompt from the goal and the reference images (Image 1+).";
    } else {
      text = goalText
        ? `Assess the RENDER UNDER REVIEW (the LAST attached image) against the goal and the reference images (Image 1+) — what worked, what didn't. The generator will NOT see the render, so describe anything worth keeping in words. Apply this direction and give an improved, corrected prompt:\n\n${goalText}`
        : "Assess the RENDER UNDER REVIEW (the LAST attached image) against the goal and the reference images (Image 1+) — what worked, what didn't. The generator will NOT see the render, so describe anything worth keeping in words. Then give an improved, corrected prompt.";
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
    ...(videos.length > 0 ? { videos } : {}),
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
  // The original request + initial prompt survive truncation via THE SPEC
  // appended to the system prompt (see effectiveSystem below), so no pinning
  // is needed here.
  // Transcript images live on disk as refs after a save (see imageStorage), so
  // hydrate the turns actually being sent — otherwise a reloaded conversation
  // would quietly go text-only. Only the sliced window is loaded, never the
  // whole history.
  let historyToSend: ConversationTurn[] = slicedPrior;
  if (!loopbackMode && saveDirectoryPath) {
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
  if (loopbackMode) {
    historyToSend = slicedPrior.map(({ images: _img, videos: _vid, ...rest }) => rest);
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
  let effectiveSystem =
    loopbackMode && nodeData.promptSkillName === LOOPBACK_SKILL_NAME
      ? LOOPBACK_SKILL
      : nodeData.systemPrompt;

  // Loopback drift anchor: append THE SPEC — the original request plus the
  // canonical initial prompt — to the system context every turn. In the system
  // slot it can't be truncated by the Max-turns cap and is clearly authoritative,
  // so the model re-aligns to it instead of drifting with the latest render.
  // (Only once the conversation has begun; the fresh first turn has neither yet.)
  if (loopbackMode && !isFreshConversation) {
    const specParts: string[] = [];
    const originalRequest = priorConversation[0]?.text?.trim();
    if (originalRequest) specParts.push(`## Original request (the north star)\n${originalRequest}`);
    if (nodeData.initialPrompt) specParts.push(`## Canonical initial prompt (the full spec first derived from that request)\n${nodeData.initialPrompt}`);
    if (specParts.length > 0) {
      effectiveSystem = `${effectiveSystem ?? ""}\n\n# THE SPEC — hold to this every turn; a constraint changes only if the user explicitly says so\n${specParts.join("\n\n")}`;
    }
    // The CURRENT WORKING PROMPT (last turn's prompt) — the model refines THIS
    // forward (textual continuity), so accumulated good detail carries over
    // instead of relying on re-observing the render each turn. THE SPEC still
    // anchors it against drift.
    const workingPrompt = nodeData.outputPrompt?.trim();
    if (workingPrompt) {
      effectiveSystem = `${effectiveSystem ?? ""}\n\n# CURRENT WORKING PROMPT — refine THIS forward: carry it over verbatim, fold in this turn's fixes, and audit it against THE SPEC (pull back any drift). Do NOT rewrite from scratch or shrink it to just the tweak.\n${workingPrompt}`;
    }
  }

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
        // When the reply had no <image_prompt> block, keep the PREVIOUS prompt
        // (never overwrite it with the assessment prose) and flag it so the user
        // knows to retry / raise Max tokens.
        const promptMissing = prompt === null;
        const keptPrompt = promptMissing ? (nodeData.outputPrompt ?? null) : prompt;
        const assistantText = promptMissing
          ? `${convoText}\n\n⚠ No image prompt was produced — the reply may have been cut off before the <image_prompt> block. The Image prompt was left unchanged; Send again, or raise Max tokens.`
          : convoText;
        const assistantTurn: ConversationTurn = {
          role: "assistant",
          text: assistantText,
          timestamp: Date.now(),
        };
        updateNodeData(node.id, {
          outputText: assistantText,
          outputPrompt: keptPrompt,
          conversation: [...persistedConversation, assistantTurn],
          // Chatbot-style: clear the compose box after a successful send so the
          // same direction isn't silently reused — but keep it when no prompt
          // came back, so the user can just Send again without retyping.
          ...(promptMissing ? {} : { composeInput: "" }),
          // Capture the conversation's FIRST prompt as the canonical initial
          // prompt (the drift anchor); a fresh conversation replaces it.
          ...(isFreshConversation && prompt ? { initialPrompt: prompt } : {}),
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
