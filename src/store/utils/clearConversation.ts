import type { LLMGenerateNodeData } from "@/types";

/**
 * Everything "Clear history" has to clear on an LLM node.
 *
 * The transcript is NOT the only thing the next request carries. When the
 * compose box is empty, `executeLlmGenerate` falls back to the stored inputs:
 *
 *   text   = composed || inputs.text || nodeData.inputPrompt
 *   images = inputs.images.length > 0 ? inputs.images : nodeData.inputImages
 *
 * and `regenerateNode` — which the Send button calls — passes
 * `useStoredFallback: true`. So clearing only `conversation` emptied the
 * displayed transcript and then re-sent the previous message and images on the
 * next Send. The model answered the old question, which reads exactly like the
 * node still remembering a conversation that was supposedly cleared.
 *
 * `clearStaleInputImages` in the store already guards this same hazard when an
 * edge is removed, for the same stated reason. This is the other door into it.
 *
 * Shared by both clear sites (the node body and the control panel) so they
 * cannot drift — two hand-maintained copies of "what clearing means" is how
 * one of them ends up incomplete again.
 */
export function clearConversationPatch(): Partial<LLMGenerateNodeData> {
  return {
    conversation: [],
    outputText: null,
    // The stored per-run fallbacks. Live pins re-supply images on the next run,
    // so dropping the mirror costs nothing a connected graph needs.
    inputPrompt: null,
    inputImages: [],
    inputImageRefs: undefined,
  };
}
