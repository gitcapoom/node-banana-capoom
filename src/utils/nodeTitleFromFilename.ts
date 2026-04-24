/**
 * Derive a node's customTitle from a dropped file's name.
 *
 * Semantics:
 *   - If the node has no customTitle yet → set it to the stripped filename.
 *   - If the existing customTitle is exactly the stripped *previous* filename
 *     (i.e. it was auto-set by us, not user-customized) → update to the new
 *     stripped filename.
 *   - Otherwise the user has typed their own title — preserve it verbatim.
 *
 * "Stripped" = the file's basename with the final extension removed.
 *
 * Returns `undefined` only when `newFilename` is falsy (nothing to derive).
 */
export function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export function deriveAutoTitle(
  newFilename: string,
  prevFilename: string | null | undefined,
  prevCustomTitle: string | undefined
): string | undefined {
  if (!newFilename) return undefined;
  const newAutoTitle = stripExtension(newFilename);

  if (!prevCustomTitle) return newAutoTitle;

  const prevAutoTitle = prevFilename ? stripExtension(prevFilename) : undefined;
  if (prevCustomTitle === prevAutoTitle) return newAutoTitle;

  // User has customized the title — preserve it.
  return prevCustomTitle;
}
