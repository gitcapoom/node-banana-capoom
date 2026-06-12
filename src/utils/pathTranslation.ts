/**
 * Path translation for the OTOSERVE10 deployment.
 *
 * The user's workstation maps drive `M:` to the `\\otoserve10\capoom_big_hw`
 * share. node-banana's server runs ON OTOSERVE10 and can only open UNC paths,
 * so any `M:\…` path that arrives from the client (e.g. a pasted RGB source
 * path) must be rewritten to UNC before it's used for file I/O. Already-UNC
 * paths and unmapped drives pass through unchanged.
 */

/** Mapped drive-letter → UNC root for this deployment. */
const DRIVE_TO_UNC: Record<string, string> = {
  M: "\\\\otoserve10\\capoom_big_hw",
};

/**
 * Rewrite a mapped-drive path (`M:\Projects\…` or `M:/Projects/…`) to its UNC
 * equivalent (`\\otoserve10\capoom_big_hw\Projects\…`). Returns the trimmed
 * input unchanged when it isn't a known mapped drive.
 */
export function driveToUnc(p: string | null | undefined): string {
  if (!p) return "";
  const trimmed = p.trim();
  const m = /^([A-Za-z]):[\\/]+(.*)$/.exec(trimmed);
  if (m) {
    const unc = DRIVE_TO_UNC[m[1].toUpperCase()];
    if (unc) return `${unc}\\${m[2].replace(/\//g, "\\")}`;
  }
  return trimmed;
}

/** Last path segment without its extension (works on UNC or POSIX separators). */
export function filenameStem(p: string | null | undefined): string {
  if (!p) return "";
  const base = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "") || base;
}
