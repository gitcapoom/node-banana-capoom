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
import { uploadFileToFal, uploadImageToFal } from "../providers/fal";
import { compressImage } from "./imageCompression";

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

/**
 * Is `candidate` inside `root`?
 *
 * Not a string prefix test. validateWorkflowPath returns its resolved path with
 * FORWARD slashes ("C:/Users/..." , "//server/share/..."), while path.join
 * builds candidates with backslashes on Windows. Comparing the two with
 * startsWith is false for every Windows path, drive-letter and UNC alike, which
 * made findMediaFile reject files that were sitting right there and report
 * "not found in the project's inputs folder".
 *
 * path.relative normalises both sides, so this is a containment test rather
 * than a text comparison: the candidate is inside when the route from root to
 * it neither climbs out (`..`) nor restarts from an absolute path (a different
 * drive or share).
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !rel.startsWith("../");
}

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
      if (!isInsideRoot(validation.resolved, candidate)) continue;
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
  origins?: RefOrigins,
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
      // Remember where this URL came from: once uploaded it is just a link, and
      // a size refusal later can only be answered by going back to the file.
      origins?.set(url, found);
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

/** Uploaded URL -> the file on disk it was uploaded from. */
export type RefOrigins = Map<string, { filePath: string; contentType: string }>;

function isRefImage(v: unknown, origins: RefOrigins): v is string {
  return typeof v === "string" && !!origins.get(v)?.contentType.startsWith("image/");
}

/** Does `value` contain any URL that was uploaded from an image on disk? */
export function hasRefImages(value: unknown, origins: RefOrigins): boolean {
  if (!origins.size) return false;
  if (isRefImage(value, origins)) return true;
  if (Array.isArray(value)) return value.some((v) => hasRefImages(v, origins));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => hasRefImages(v, origins));
  }
  return false;
}

/**
 * Compress images that were sent by reference, for a retry after a size refusal.
 *
 * Media over the browser's inline threshold reaches the server as a reference
 * and is uploaded to the CDN before the provider is called, so by the time a
 * provider answers "too large" the request holds only a URL — there is nothing
 * to compress. This goes back to the file on disk, compresses it the same way
 * an inline image would be (imageCompression.compressImage), uploads the
 * smaller copy and swaps its URL in. Videos and non-ref values are untouched.
 */
export async function recompressRefImages<T>(
  value: T,
  origins: RefOrigins,
  falApiKey: string | null,
  memo: Map<string, string> = new Map(),
): Promise<T> {
  const walk = async (v: unknown): Promise<unknown> => {
    if (isRefImage(v, origins)) {
      const done = memo.get(v);
      if (done) return done;
      const { filePath, contentType } = origins.get(v)!;
      const bytes = await fs.readFile(filePath);
      const smaller = await compressImage(`data:${contentType};base64,${bytes.toString("base64")}`);
      const url = await uploadImageToFal(smaller, falApiKey);
      memo.set(v, url);
      return url;
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = await walk(item);
      return out;
    }
    return v;
  };
  return (await walk(value)) as T;
}
