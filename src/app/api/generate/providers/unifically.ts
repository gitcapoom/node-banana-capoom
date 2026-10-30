/**
 * Unifically provider (https://api.unifically.com).
 *
 * One endpoint for every model: `POST /v1/tasks {model, input}` returns a
 * task id, `GET /v1/tasks/{id}` polls it. Responses use a
 * `{success, code, data}` envelope; failures carry `data.message` (submit) or
 * `error_message` (task).
 *
 * Inputs must be publicly reachable URLs, so data URLs are uploaded first. The
 * fal CDN is used when a fal key is present — it does not re-encode and handles
 * multipart for large files — otherwise Unifically's own storage, whose own
 * example turns an uploaded PNG into a .webp.
 *
 * Output keys vary by model (`video_url`, `image_urls`, `audio_url`, …), so the
 * result is collected by walking `output` for URLs rather than reading one
 * fixed field.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import type { NormalizedSchema } from "@/lib/schema/types";
import { GENERATION_MAX_WAIT_MS } from "../utils/timeouts";
import { waitUnlessCancelled, cancelledOutput } from "../utils/cancellation";
import { validateMediaUrl } from "@/utils/urlValidation";
import { uploadImageToFal } from "./fal";
import { UNIFICALLY_API_BASE, getUnificallyNormalizedSchema } from "@/lib/unifically/modelFetcher";

const POLL_INTERVAL_MS = 3000;
const MAX_MEDIA_SIZE = 500 * 1024 * 1024;
/** Matches the other providers: a video this large is returned by URL only. */
const LARGE_VIDEO_BYTES = 20 * 1024 * 1024;

/** Fields that carry the prompt on models that do not call it `prompt`. */
const PROMPT_ALIASES = ["prompt", "text", "lyrics", "input_text", "script", "description"];

export interface UnificallyRunOptions {
  pollIntervalMs?: number;
  /** fal key for uploading data URLs; Unifically storage is used without one. */
  falApiKey?: string | null;
  /** Override for tests; normally looked up from the docs index. */
  schema?: NormalizedSchema | null;
}

async function uploadToUnifically(dataUrl: string, apiKey: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const contentType = header.slice(5, header.indexOf(";")) || "application/octet-stream";
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), `upload.${contentType.split("/")[1] || "bin"}`);
  const resp = await fetch("https://files.unifically.com/upload", {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const json = (await resp.json().catch(() => null)) as { success?: boolean; file_url?: string; message?: string } | null;
  if (!resp.ok || !json?.success || !json.file_url) {
    throw new Error(`Unifically upload failed: ${json?.message ?? resp.status}`);
  }
  return json.file_url;
}

async function makePublic(value: string, apiKey: string, falApiKey: string | null | undefined): Promise<string> {
  if (!value.startsWith("data:")) return value;
  return falApiKey ? uploadImageToFal(value, falApiKey) : uploadToUnifically(value, apiKey);
}

async function makeAllPublic(
  value: string | string[],
  apiKey: string,
  falApiKey: string | null | undefined
): Promise<string | string[]> {
  return Array.isArray(value)
    ? Promise.all(value.map((v) => makePublic(v, apiKey, falApiKey)))
    : makePublic(value, apiKey, falApiKey);
}

/** Where the node's prompt goes: `prompt`, or the model's own name for it. */
export function promptField(schema: NormalizedSchema | null): string {
  if (!schema) return "prompt";
  return PROMPT_ALIASES.find((n) => schema.properties[n]?.type === "string") ?? "prompt";
}

/** Where generic, un-pinned images go when the model has an image list field. */
export function genericImageField(schema: NormalizedSchema | null): { name: string; isArray: boolean } {
  if (!schema) return { name: "image_urls", isArray: true };
  const names = Object.keys(schema.properties);
  const pick =
    names.find((n) => n === "image_urls") ??
    names.find((n) => /image_urls$/.test(n)) ??
    names.find((n) => n === "image_url") ??
    names.find((n) => /image_url$/.test(n));
  if (!pick) return { name: "image_urls", isArray: true };
  return { name: pick, isArray: schema.properties[pick].type === "array" };
}

type Media = { url: string; kind: "image" | "video" | "audio" };

/** Every URL in a task's output, typed from its key or extension. */
export function collectOutputs(output: unknown): Media[] {
  const found: Media[] = [];
  const kindOf = (key: string, url: string): Media["kind"] => {
    const k = key.toLowerCase();
    const ext = (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
    if (k.includes("video") || ["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
    if (k.includes("audio") || k.includes("song") || k.includes("music") || ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
    return "image";
  };
  const walk = (v: unknown, key: string) => {
    if (typeof v === "string") {
      if (/^https?:\/\//i.test(v) && !/cover|thumbnail|poster|preview/i.test(key)) found.push({ url: v, kind: kindOf(key, v) });
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, key);
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) walk(item, k);
    }
  };
  walk(output, "");
  // The same file can appear under two keys; keep the first.
  return found.filter((m, i) => found.findIndex((x) => x.url === m.url) === i);
}

function envelopeError(json: unknown, status: number): string {
  const d = (json as { data?: { message?: string; error?: string; error_message?: string } } | null)?.data;
  const top = json as { message?: string; error_message?: string } | null;
  return d?.message || d?.error_message || d?.error || top?.message || top?.error_message || `HTTP ${status}`;
}

export async function generateWithUnifically(
  requestId: string,
  apiKey: string,
  input: GenerationInput,
  options: UnificallyRunOptions = {}
): Promise<GenerationOutput> {
  const modelId = input.model.id;
  const schema = options.schema !== undefined ? options.schema : await getUnificallyNormalizedSchema(modelId);
  const body: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(input.parameters ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    body[k] = v;
  }

  try {
    for (const [k, raw] of Object.entries(input.dynamicInputs ?? {})) {
      if (raw === null || raw === undefined || raw === "") continue;
      let value: unknown = await makeAllPublic(raw, apiKey, options.falApiKey);
      // Wrap a lone value the schema declares as a list. Never unwrap: the
      // client already shaped the value from the same schema, and discarding
      // array elements is what broke fal for every optional array field.
      if (schema?.properties[k]?.type === "array" && !Array.isArray(value)) value = [value];
      body[k] = value;
    }

    // Generic images[] that no pin claimed.
    if (input.images?.length) {
      const target = genericImageField(schema);
      if (body[target.name] === undefined) {
        const urls = (await makeAllPublic(input.images, apiKey, options.falApiKey)) as string[];
        body[target.name] = target.isArray ? urls : urls[0];
      }
    }
  } catch (err) {
    return { success: false, error: `${input.model.name}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const pField = promptField(schema);
  if (input.prompt && body[pField] === undefined) body[pField] = input.prompt;

  console.log(`[API:${requestId}] Unifically submit model=${modelId} keys=${Object.keys(body).join(", ")}`);

  let taskId: string | undefined;
  try {
    const resp = await fetch(`${UNIFICALLY_API_BASE}/v1/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, input: body }),
    });
    const json = (await resp.json().catch(() => null)) as { success?: boolean; data?: { task_id?: string } } | null;
    if (!resp.ok || json?.success === false) {
      return { success: false, error: `${input.model.name}: ${envelopeError(json, resp.status)}` };
    }
    taskId = json?.data?.task_id;
  } catch (err) {
    return { success: false, error: `${input.model.name}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!taskId) return { success: false, error: `${input.model.name}: No task id in response` };

  // ── Poll ───────────────────────────────────────────────────────────
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + GENERATION_MAX_WAIT_MS;
  let output: unknown;
  while (true) {
    if (Date.now() > deadline) {
      return { success: false, error: `${input.model.name}: Timed out after ${Math.round(GENERATION_MAX_WAIT_MS / 60000)} minutes` };
    }
    // Unifically has no cancel endpoint: stop polling, the job still runs and bills.
    if (await waitUnlessCancelled(interval, input.signal)) return cancelledOutput(requestId, "Unifically", false);
    let json: { success?: boolean; data?: { status?: string; output?: unknown; error_message?: string; message?: string } } | null;
    let status: number;
    try {
      const resp = await fetch(`${UNIFICALLY_API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      status = resp.status;
      json = await resp.json().catch(() => null);
      if (!resp.ok) {
        if (status === 429 || status >= 500) continue; // transient
        return { success: false, error: `${input.model.name}: ${envelopeError(json, status)}` };
      }
    } catch {
      continue; // network blip — keep polling until the deadline
    }
    const st = json?.data?.status;
    if (st === "completed") {
      output = json?.data?.output;
      break;
    }
    if (st === "failed") {
      return { success: false, error: `${input.model.name}: ${envelopeError(json, status)}` };
    }
  }

  const media = collectOutputs(output);
  if (!media.length) return { success: false, error: `${input.model.name}: No outputs in task result` };

  // ── Download ───────────────────────────────────────────────────────
  const outputs: NonNullable<GenerationOutput["outputs"]> = [];
  for (const m of media) {
    const check = validateMediaUrl(m.url);
    if (!check.valid) return { success: false, error: `${input.model.name}: Invalid output URL: ${check.error}` };
    const resp = await fetch(m.url);
    if (!resp.ok) return { success: false, error: `${input.model.name}: Failed to fetch output (${resp.status})` };
    const declared = parseInt(resp.headers.get("content-length") || "0", 10);
    if (m.kind === "video" && declared > LARGE_VIDEO_BYTES) {
      outputs.push({ type: "video", data: "", url: m.url });
      continue;
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(buf.byteLength / 1048576).toFixed(0)}MB > 500MB limit` };
    }
    if (m.kind === "video" && buf.byteLength > LARGE_VIDEO_BYTES) {
      outputs.push({ type: "video", data: "", url: m.url });
      continue;
    }
    const fallback = m.kind === "video" ? "video/mp4" : m.kind === "audio" ? "audio/mpeg" : "image/png";
    const mime = resp.headers.get("content-type")?.split(";")[0] || fallback;
    outputs.push({ type: m.kind, data: `data:${mime};base64,${Buffer.from(buf).toString("base64")}`, url: m.url });
  }

  console.log(`[API:${requestId}] Unifically SUCCESS - ${outputs.length} output(s)`);
  return { success: true, outputs };
}
