import type { ModelInputDef } from "@/types";

/**
 * Does the selected model actually take a prompt?
 *
 * Generator nodes used to demand a text input unconditionally, which is wrong
 * for the pure image->image utilities on fal: `imageutils/marigold-depth`,
 * background removal, upscalers and the rest declare ONE image input and no
 * prompt field at all. Running one asked for a text input that does not exist,
 * and there was nowhere to connect it.
 *
 * A missing or empty schema means "we do not know yet" — the schema fetch may
 * not have resolved, and some providers (kie) ship schemas that list only a
 * prompt. Requiring a prompt is the safe answer there, and matches the
 * behaviour every model had before this existed.
 */
export function modelTakesPrompt(inputSchema: ModelInputDef[] | undefined): boolean {
  if (!inputSchema || inputSchema.length === 0) return true;
  return inputSchema.some((i) => i.type === "text");
}

/**
 * A model that takes no prompt still needs SOMETHING to work on. Used to tell
 * "this model doesn't want a prompt" apart from "nothing is wired up at all",
 * so the second case still gets a clear error instead of an empty request.
 */
export function hasAnyMediaInput(
  images: string[],
  dynamicInputs: Record<string, unknown>,
): boolean {
  if (images.length > 0) return true;
  return Object.values(dynamicInputs).some(
    (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
}
