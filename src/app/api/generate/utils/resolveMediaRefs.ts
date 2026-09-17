/**
 * Turn `nbfile:<id>` sentinels into provider-visible URLs.
 *
 * The browser sends a reference instead of the bytes when media is too large to
 * inline (see src/lib/mediaRefs.ts). The file is already in the project's
 * `inputs/` or `generations/` folder, so the server reads it from disk and
 * uploads it to the fal CDN — the same host muapi already uses for images it
 * cannot send as data URIs.
 *
 * Path handling is deliberately the same shape as the workflow-images GET
 * route: validate the project directory, reduce the id to a basename, and only
 * look inside the known media folders. The id comes from the client, so it is
 * treated as hostile — an id is a filename, never a path.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { validateWorkflowPath } from "@/utils/pathValidation";
import { parseMediaRef } from "@/lib/mediaRefs";
import { uploadFileToFal } from "../providers/fal";

/** Extensions searched, in order, for a bare media id. */
const MEDIA_EXTENSIONS = [
  "mp4", "webm", "mov",              // video first: refs are used for big files
  "png", "jpg", "jpeg", "gif", "webp",
  "mp3", "wav", "ogg",
  "glb", "spz", "exr",
] as const;

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  glb: "model/gltf-binary",
  spz: "application/octet-stream",
  exr: "image/x-exr",
};

/** Locate a media id on disk, or null. */
export async function findMediaFile(
  mediaDirectory: string,
  id: string,
): Promise<{ filePath: string; contentType: string } | null> {
  const validation = validateWorkflowPath(mediaDirectory);
  if (!validation.valid) return null;

  // An id is a filename. basename() strips any path the client tried to smuggle.
  const safeId = path.basename(id);
  if (safeId !== id || id.includes("..")) return null;

  const folders = [
    path.join(validation.resolved, "inputs"),
    path.join(validation.resolved, "generations"),
  ];

  for (const folder of folders) {
    for (const ext of MEDIA_EXTENSIONS) {
      const candidate = path.join(folder, `${safeId}.${ext}`);
      // Belt and braces: the resolved candidate must still sit inside the
      // project, whatever the id contained.
      if (!candidate.startsWith(validation.resolved)) continue;
      try {
        await fs.access(candidate);
        return { filePath: candidate, contentType: CONTENT_TYPES[ext] ?? "application/octet-stream" };
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Replace every `nbfile:` sentinel in `value` with an uploaded URL.
 *
 * Walks strings and arrays, which is the shape `dynamicInputs` takes. Uploads
 * are memoised per id so the same clip wired to two pins is sent once.
 */
export async function resolveMediaRefs<T>(
  value: T,
  mediaDirectory: string | null | undefined,
  falApiKey: string | null,
  cache: Map<string, string> = new Map(),
): Promise<T> {
  const walk = async (v: unknown): Promise<unknown> => {
    const id = parseMediaRef(v);
    if (id) {
      if (!mediaDirectory) {
        throw new Error(
          "This media is stored on disk but the project directory was not sent, so it cannot be uploaded. Save the project and try again.",
        );
      }
      const cached = cache.get(id);
      if (cached) return cached;
      const found = await findMediaFile(mediaDirectory, id);
      if (!found) {
        throw new Error(`Referenced media "${id}" was not found in the project's inputs folder.`);
      }
      const url = await uploadFileToFal(found.filePath, found.contentType, falApiKey);
      cache.set(id, url);
      return url;
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    // Objects matter: the top-level argument IS `dynamicInputs`, a record of
    // fields. Walking only strings and arrays returned it untouched — the
    // asymmetry with hasMediaRefs, which did walk objects, is what made this
    // look like it worked while resolving nothing.
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        out[k] = await walk(item);
      }
      return out;
    }
    return v;
  };

  return (await walk(value)) as T;
}

/** Is there anything to resolve? Avoids touching the payload when there is not. */
export function hasMediaRefs(value: unknown): boolean {
  if (parseMediaRef(value)) return true;
  if (Array.isArray(value)) return value.some(hasMediaRefs);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasMediaRefs);
  }
  return false;
}
