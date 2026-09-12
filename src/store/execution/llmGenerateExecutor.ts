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
import { cheapUrlKey } from "@/utils/renderSignature";
import { derivePrompt, tagInstruction, retryInstruction } from "./derivePrompt";

export interface LlmGenerateOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}


/**
 * Send each distinct image at most ONCE per request, at its earliest position.
 *
 * A still-connected image pin re-sent the same picture on every turn, so a
 * ten-turn chat uploaded it ten times: ten times the tokens and latency, and a
 * fast route to Anthropic's >20-image threshold (which downsamples every image
 * in the request to 2000px). Disconnecting the pin avoids it, but nobody
 * remembers to, and the bill shows up as a context-limit error many turns later.
 *
 * This runs over the whole outgoing array — history AND the new turn — rather
 * than filtering only the new turn, and the transcript keeps every turn's own
 * copy. That distinction matters: anchoring an image to the single turn that
 * first sent it made the conversation fragile, because deleting that one turn
 * (the transcript's per-turn X) while the pin was disconnected erased the image
 * from every later request and from the save. Here each turn stays
 * self-sufficient on disk and only the wire is thinned, so whichever turns
 * survive, the earliest one still carries the picture.
 *
 * Keyed off `turn.images` only — never `imageRefs`. A ref is a pointer to a
 * file; if its load failed upstream the turn goes out text-only and the image
 * is NOT in the payload. Counting refs would suppress a later copy on the
 * strength of one that was never sent, which is the one way this can corrupt a
 * conversation rather than merely fail to save bandwidth.
 *
 * Missing a match only costs a redundant upload; a false match loses an image.
 * So it errs toward sending: different encodings of one picture key
 * differently and are both sent.
 */
export function dedupeImagesAcrossTurns(messages: ConversationTurn[]): ConversationTurn[] {
  const seen = new Set<string>();
  return messages.map((turn) => {
    if (!turn.images?.length) return turn;
    const keep = turn.images.filter((url) => {
      if (!url) return false;
      const key = cheapUrlKey(url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (keep.length === turn.images.length) return turn;
    if (keep.length > 0) return { ...turn, images: keep };
    // Drop the key entirely rather than sending `images: []`, so the turn looks
    // exactly like one that never had an image.
    const { images: _dropped, ...rest } = turn;
    return rest as ConversationTurn;
  });
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

  // The turn RECORDED in the transcript always carries the full set, so every
  // turn stands on its own if a neighbour is later deleted.
  const newUserTurn: ConversationTurn = {
    role: "user",
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(videos.length > 0 ? { videos } : {}),
    timestamp: Date.now(),
  };

  // Only the WIRE is thinned, and only once the window is sliced and hydrated —
  // what is worth sending depends on what this particular request contains.
  // One-shot mode has no history, so there is nothing to dedupe against.
  const outboundMessages: ConversationTurn[] = useConversation
    ? dedupeImagesAcrossTurns([...historyToSend, newUserTurn])
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
    // A warning from the previous Send must not look like it describes this one.
    derivedWarning: null,
    lastGenerationCost: null,
  });

  const headers = buildLlmHeaders(nodeData.provider, providerSettings);

  const generatorFriendly = nodeData.generatorFriendly === true;
  // A negative prompt is a generator artifact, so it only means anything
  // alongside a generator prompt.
  const wantNegative = generatorFriendly && nodeData.generateNegativePrompt === true;

  // The tag instruction rides along with the user's own system prompt rather
  // than replacing it — their instructions still govern the reply; this only
  // says what to append to it.
  // A loaded prompt skill defines its own output format (the Kling v3 skill
  // ships fal's labelled block). Telling the model to write comma-separated
  // phrases on top of that flattened the skill's template inside <prompt>.
  const skillDefinesFormat = !!nodeData.promptSkillName;
  const effectiveSystem = generatorFriendly
    ? `${nodeData.systemPrompt ?? ""}${tagInstruction(wantNegative, skillDefinesFormat)}`
    : nodeData.systemPrompt;

  /** One request to the model, returning its text. Used for the derivation's
   *  retry and shrink passes, which are extra round trips on the same node. */
  const askModel = async (messages: ConversationTurn[], system?: string): Promise<string> => {
    const res = await fetch("/api/llm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages,
        ...(system ? { system } : {}),
        provider: nodeData.provider,
        model: nodeData.model,
        // The whole bag. The route filters it against the model's own schema,
        // so an unsupported value stays in node data (switch models and back
        // and it is still there) without ever reaching the provider.
        parameters: nodeData.parameters,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j.success || !j.text) throw new Error(j.error || "LLM call failed");
    return j.text as string;
  };

  try {
    const response = await fetch("/api/llm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: outboundMessages,
        ...(effectiveSystem ? { system: effectiveSystem } : {}),
        provider: nodeData.provider,
        model: nodeData.model,
        parameters: nodeData.parameters,
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

      // Derive the generator-ready prompt, if asked for. Nothing here can fail
      // the run: the worst case is an unstripped prompt with a warning badge.
      let derived: {
        derivedPrompt?: string | null;
        derivedNegativePrompt?: string | null;
        derivedWarning?: string | null;
      } = {};
      if (generatorFriendly) {
        const r = await derivePrompt(
          result.text,
          { wantNegative, maxChars: nodeData.maxPromptChars ?? null },
          {
            // Hand the model its OWN answer back and ask for the block alone —
            // cheaper than re-running the request, and it does not have to redo
            // the thinking.
            retry: (failedReply) =>
              askModel(
                [
                  ...outboundMessages,
                  { role: "assistant", text: failedReply, timestamp: Date.now() },
                  { role: "user", text: retryInstruction(wantNegative, skillDefinesFormat), timestamp: Date.now() },
                ],
                effectiveSystem,
              ),
            // No system prompt here: this is a pure text operation and the
            // node's own instructions would only pull the answer off task.
            shrink: (text, limit) =>
              askModel([
                {
                  role: "user",
                  text:
                    `Shorten this image prompt to under ${limit} characters. It is currently ` +
                    `${text.length}. Keep the meaning and the most important visual detail; ` +
                    `drop the least important. Return ONLY the shortened prompt.

${text}`,
                  timestamp: Date.now(),
                },
              ]),
          },
        );
        derived = {
          derivedPrompt: r.prompt,
          derivedNegativePrompt: r.negativePrompt,
          derivedWarning: r.warning,
        };
      }

      updateNodeData(node.id, {
        ...derived,
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
