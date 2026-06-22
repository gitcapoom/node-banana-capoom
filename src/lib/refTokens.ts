/**
 * Stable prompt-reference tokens (the "Option B" indirection).
 *
 * Some models ask you to reference inputs in the prompt by POSITION — e.g.
 * Seedance/Kling: "refer to them as @Image1, @Image2 …". Positional tokens are
 * fragile: deleting/reordering a reference shifts every later number, silently
 * breaking the prompt.
 *
 * Instead, each reference pin gets a STABLE token derived from its (stable) slot
 * index — `@ImageA`, `@ImageB`, `@VideoA`, … The user types the stable token in
 * the prompt; at submit time we translate it to the positional token the model
 * expects (`@Image1`), based on the input's CURRENT position. The authored
 * prompt is never mutated, and a removed reference's token simply drops out.
 *
 * Pure module (no React / no store) — shared by extraction, the handle
 * renderer, and getConnectedInputs.
 */

/**
 * Detect a prompt-reference convention from a field description.
 * "Refer to them in the prompt as @Image1, @Image2" → "Image".
 */
export function detectRefConvention(description?: string): string | undefined {
  if (!description) return undefined;
  const m = description.match(/@([A-Z][a-zA-Z]+)\d/);
  return m ? m[1] : undefined;
}

/** Stable display letter for a slot index: 0→A … 25→Z, then s{n} as a fallback. */
export function slotToLetter(slot: number): string {
  return slot >= 0 && slot < 26 ? String.fromCharCode(65 + slot) : `s${slot}`;
}

/** Inverse of slotToLetter. Returns -1 if not a recognized token. */
export function letterToSlot(letter: string): number {
  if (/^[A-Z]$/.test(letter)) return letter.charCodeAt(0) - 65;
  const m = letter.match(/^s(\d+)$/);
  return m ? Number(m[1]) : -1;
}

/** The stable token a user types for a given convention + slot, e.g. "@ImageA". */
export function stableRefToken(conv: string, slot: number): string {
  return `@${conv}${slotToLetter(slot)}`;
}

/**
 * Rewrite stable reference tokens (e.g. `@ImageA`) in a prompt into the
 * positional tokens the model expects (`@Image1`), using the current connected
 * slots (sorted ascending; rank = index + 1). Tokens whose slot is no longer
 * connected (a removed reference) are dropped.
 *
 * Positional tokens already in the text (`@Image1`) are left untouched.
 */
export function translateReferenceTokens(
  text: string,
  conv: string,
  connectedSlotsSorted: number[]
): string {
  const re = new RegExp(`@${conv}([A-Z]|s\\d+)`, "g");
  return text.replace(re, (_full, tok: string) => {
    const slot = letterToSlot(tok);
    const rank = connectedSlotsSorted.indexOf(slot);
    return rank === -1 ? "" : `@${conv}${rank + 1}`;
  });
}

/**
 * Replace arbitrary named tokens (e.g. a router's `@Hero`, `@A`) with their
 * mapped values (e.g. `@Image1`). Keys include the leading `@`. Matches at a
 * trailing word boundary so `@A` doesn't fire inside `@Apple`; longer tokens are
 * tried first so `@Hero` wins over a hypothetical `@H`.
 */
export function replaceNamedTokens(text: string, map: Record<string, string>): string {
  const keys = Object.keys(map);
  if (keys.length === 0) return text;
  const escaped = keys
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:${escaped.join("|")})\\b`, "g");
  return text.replace(re, (m) => map[m] ?? m);
}
