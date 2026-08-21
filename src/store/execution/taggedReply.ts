/**
 * Pull the generator-ready blocks out of an LLM reply.
 *
 * Generalised from the loopback parser, which read a single `<image_prompt>`.
 * The protocol asks the model for its conversational answer followed by
 * `<prompt>…</prompt>`, and optionally `<negative_prompt>…</negative_prompt>`,
 * in the SAME reply — one call rather than a second derivation pass.
 *
 * `reply` is the raw text, tags and all: the transcript has to stay faithful to
 * what the model actually said. Stripping is an export concern, not a history
 * one.
 *
 * Known weakness, accepted deliberately: a model sometimes omits the block
 * entirely. That is what the caller's single stricter retry and the
 * "prompt not stripped" fallback exist for.
 */

/**
 * The LAST non-empty block wins. When a model restates itself — thinking aloud
 * and then correcting — the final one is the answer it settled on.
 *
 * The inner match is non-greedy so two blocks are read as two, not as one
 * spanning both. `[\s\S]` rather than `.` so multi-line prompts survive.
 */
function lastBlock(raw: string, tag: string): string | null {
  // Case-insensitive: models emit <PROMPT> and <Prompt> often enough that the
  // loopback parser matched case-insensitively too. Losing that in the rewrite
  // would have been a silent regression.
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  let out: string | null = null;
  for (const m of raw.matchAll(re)) {
    const inner = m[1].trim();
    if (inner) out = inner;
  }
  return out;
}

export interface TaggedReply {
  /** The raw reply, unmodified. */
  reply: string;
  /** Contents of the last non-empty `<prompt>` block, or null. */
  prompt: string | null;
  /** Contents of the last non-empty `<negative_prompt>` block, or null. */
  negativePrompt: string | null;
}

export function parseTaggedReply(raw: string): TaggedReply {
  // Never throws: a malformed reply degrades to "no blocks", which the caller
  // handles. Throwing here would turn a sloppy answer into a failed run.
  const text = typeof raw === "string" ? raw : "";
  return {
    reply: text,
    // `negative_prompt` is matched by its own tag, so `<prompt>` cannot capture
    // it: the opening tags differ, and the regex anchors on both ends.
    prompt: lastBlock(text, "prompt"),
    negativePrompt: lastBlock(text, "negative_prompt"),
  };
}
