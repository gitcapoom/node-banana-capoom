import { parseTaggedReply } from "./taggedReply";
import { shrinkToLimit, type ShrinkCall } from "./shrinkPrompt";

/**
 * Turn a conversational reply into a generator-ready prompt.
 *
 * The protocol asks for the reply and the blocks in ONE call, which is what
 * keeps a normal Send at a single round trip. Its known weakness is the model
 * omitting the block — the same shape loopback used, adopted here knowingly —
 * so a single stricter retry sits behind it, and a visible fallback behind
 * that. Nothing here ever fails a run: the worst case is an unstripped prompt
 * with a warning attached.
 */

/**
 * The instruction appended to the system prompt when this is switched on.
 *
 * `skillDefinesFormat` is the whole reason this takes a second argument. The
 * default text dictates the SHAPE of the prompt — "comma-separated descriptive
 * phrases" — which is right for a bare image generator and flatly wrong for a
 * loaded prompt skill that ships its own output format. The Kling v3 skill, for
 * one, specifies fal's labelled block (Scene: / Subject motion: / Camera: ...);
 * with the default text appended after it the model dutifully wrote the
 * template in its reply and then flattened it into comma-separated prose inside
 * <prompt> — and the block is the part that is actually used, so the format was
 * lost exactly where it mattered.
 *
 * When a skill is loaded it owns the format and this supplies only delimiters.
 */
export function tagInstruction(wantNegative: boolean, skillDefinesFormat = false): string {
  const form = skillDefinesFormat
    ? [
        "Inside that block put ONLY the prompt itself: no preamble, no commentary,",
        "no quotes. Use EXACTLY the prompt format the instructions above specify —",
        "keep its labels, sections and line breaks verbatim. Do not flatten it into",
        "prose and do not restyle it.",
      ]
    : [
        "Inside that block put ONLY the prompt: no preamble,",
        "no commentary, no markdown, no quotes. Write it as a generator expects —",
        "comma-separated descriptive phrases, not a sentence addressed to anyone.",
      ];
  return [
    "",
    "---",
    "After your reply, output a generator-ready image prompt inside a single",
    "<prompt></prompt> block.",
    ...form,
    ...(wantNegative
      ? [
          "Then output a <negative_prompt></negative_prompt> block containing only",
          "the things that must NOT appear.",
        ]
      : []),
  ].join("\n");
}

/** The retry sent when the reply came back without a <prompt> block. */
export function retryInstruction(wantNegative: boolean, skillDefinesFormat = false): string {
  // The retry hands the model its own reply back and asks for the block alone,
  // so it has to repeat the format rule — otherwise the second attempt reverts
  // to prose and quietly undoes the fix on exactly the requests that needed it.
  const keep = skillDefinesFormat
    ? " Keep the prompt format from the instructions above exactly: labels, sections and line breaks verbatim."
    : "";
  return wantNegative
    ? `Return ONLY the <prompt></prompt> and <negative_prompt></negative_prompt> blocks for that answer. No other text.${keep}`
    : `Return ONLY the <prompt></prompt> block for that answer. No other text.${keep}`;
}

export interface DeriveOptions {
  wantNegative: boolean;
  maxChars?: number | null;
}

export interface DeriveDeps {
  /** Ask again for the blocks alone, given the reply that omitted them. */
  retry: (failedReply: string) => Promise<string>;
  /** Ask the model to shorten a prompt to under `limit` characters. */
  shrink: ShrinkCall;
}

export interface DeriveResult {
  prompt: string;
  negativePrompt: string | null;
  warning: string | null;
  /** True when the retry had to run — useful for cost accounting and tests. */
  retried: boolean;
}

export async function derivePrompt(
  reply: string,
  opts: DeriveOptions,
  deps: DeriveDeps,
): Promise<DeriveResult> {
  const warnings: string[] = [];
  let parsed = parseTaggedReply(reply);
  let retried = false;

  // One stricter retry, and only one. It hands the model its OWN answer back
  // and asks for the block alone, which is cheaper than re-running the original
  // request and does not make it redo the thinking.
  if (!parsed.prompt) {
    retried = true;
    try {
      const again = await deps.retry(reply);
      const reparsed = parseTaggedReply(again ?? "");
      if (reparsed.prompt) {
        parsed = { ...reparsed, reply: parsed.reply };
      }
    } catch {
      // Falls through to the unstripped fallback below.
    }
  }

  let prompt: string;
  if (parsed.prompt) {
    prompt = parsed.prompt;
  } else {
    // Better an unstripped prompt the user can see and fix than an empty one.
    prompt = reply;
    warnings.push("prompt not stripped");
  }

  const negativePrompt = opts.wantNegative ? parsed.negativePrompt : null;
  if (opts.wantNegative && !negativePrompt) {
    warnings.push("no negative prompt returned");
  }

  if (opts.maxChars) {
    const shrunk = await shrinkToLimit(prompt, opts.maxChars, deps.shrink);
    prompt = shrunk.text;
    if (shrunk.warning) warnings.push(shrunk.warning);
  }

  return {
    prompt,
    negativePrompt,
    warning: warnings.length ? warnings.join(" · ") : null,
    retried,
  };
}
