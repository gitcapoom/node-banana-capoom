/**
 * Luma Agents provider (https://agents.lumalabs.ai/v1).
 *
 * One endpoint serves every capability: `POST /generations` takes a `model` and
 * a `type` and returns a job id, `GET /generations/{id}` polls it. So unlike
 * fal or Replicate there is no per-model endpoint — the model plus the
 * generation type together make the contract.
 *
 * node-banana therefore addresses Luma as `"<model>/<type>"` — `uni-1/image`,
 * `ray-3.2/video_reframe`, `uni-1/layering`. The pair is split back apart here.
 *
 * Two things about this API shape the code below:
 *
 *  - **Output URLs are presigned and expire after one hour.** They are
 *    downloaded immediately rather than handed upstream as links.
 *  - **`type: "layering"` returns up to ten outputs**, front-to-back with the
 *    background last, each cropped to its alpha bounding box. Every other type
 *    returns one. The outputs array is returned whole so the layering node can
 *    use all of it.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { GENERATION_MAX_WAIT_MS } from "../utils/timeouts";
import { waitUnlessCancelled, cancelledOutput } from "../utils/cancellation";
import { validateMediaUrl } from "@/utils/urlValidation";
import { setAtPath } from "./deepSet";

const LUMA_API_BASE = "https://agents.lumalabs.ai/v1";
const POLL_INTERVAL_MS = 2000;
const MAX_MEDIA_SIZE = 500 * 1024 * 1024;

/**
 * Generation types, used ONLY to split "<model>/<type>" back apart.
 *
 * Not a gate on which models exist — that list is discovered from Luma's docs
 * (src/lib/luma/parseDocs.ts). An id whose tail is not one of these is treated
 * as a bare model name, so a future Luma model with an unfamiliar suffix still
 * reaches the API, which is the authority on whether it is real.
 */
const KNOWN_TYPES = new Set([
  "image",
  "image_edit",
  "video",
  "video_edit",
  "video_reframe",
  "layering",
]);

/** Video types produce an MP4; everything else produces stills. */
const VIDEO_TYPES = new Set(["video", "video_edit", "video_reframe"]);

export interface LumaModelRef {
  model: string;
  type: string;
}

/**
 * Split `"uni-1/image"` into its model and type.
 *
 * Splits on the LAST slash because model names themselves may contain one
 * (Luma's are flat today, but nothing promises that). When the tail is not a
 * recognised type the whole string is the model and `type` is left undefined,
 * so the request omits it and Luma applies its own default.
 */
export function splitLumaModelId(modelId: string): LumaModelRef | { model: string; type?: undefined } {
  const idx = modelId.lastIndexOf("/");
  if (idx > 0) {
    const tail = modelId.slice(idx + 1);
    if (KNOWN_TYPES.has(tail)) return { model: modelId.slice(0, idx), type: tail };
  }
  return { model: modelId };
}

/** A Luma `ImageRef`: exactly one of url / data+media_type / file_id / generation_id. */
export interface LumaImageRef {
  url?: string;
  data?: string;
  media_type?: string;
  file_id?: string;
  generation_id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// [\s\S] rather than the dotAll flag: base64 payloads contain no newlines,
// but the `s` flag needs an es2018 target and this file compiles below that.
const DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]*)$/;

/**
 * Turn one canvas value into an ImageRef.
 *
 * The canvas hands over a base64 data URL, an http(s) URL, or — when chaining
 * off a previous Luma job — a bare generation UUID. Luma wants `data` as raw
 * base64 with a separate `media_type`, so the data-URL prefix is stripped
 * rather than passed through; sending the whole `data:` string is rejected.
 */
export function toLumaImageRef(value: string): LumaImageRef | null {
  if (!value) return null;
  const dataM = DATA_URL_RE.exec(value);
  if (dataM) return { data: dataM[2], media_type: dataM[1] };
  if (/^https?:\/\//i.test(value)) return { url: value };
  if (UUID_RE.test(value)) return { generation_id: value };
  return null;
}

function isImageRefLike(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Coerce a dynamic input into whatever shape its Luma field expects.
 *
 * Fields whose name is `source`, `start_frame`, `end_frame`, `guide_frame` or
 * ends in `_frame` take a single ImageRef; `image_ref` and `keyframes` take an
 * array of them. Everything else (prompt, booleans, enums, numbers) passes
 * through untouched.
 */
function shapeValue(field: string, value: unknown): unknown {
  const leaf = field.split(".").pop() ?? field;
  const wantsRefArray = leaf === "image_ref" || leaf === "keyframes";
  const wantsRef =
    leaf === "source" || leaf === "guide_frame" || leaf.endsWith("_frame");

  if (wantsRefArray) {
    const list = Array.isArray(value) ? value : [value];
    const refs = list
      .map((v) => (isImageRefLike(v) ? (v as LumaImageRef) : typeof v === "string" ? toLumaImageRef(v) : null))
      .filter((r): r is LumaImageRef => !!r);
    return refs.length ? refs : undefined;
  }
  if (wantsRef) {
    const one = Array.isArray(value) ? value[0] : value;
    if (isImageRefLike(one)) return one;
    return typeof one === "string" ? toLumaImageRef(one) ?? undefined : undefined;
  }
  return value;
}

interface LumaGeneration {
  id?: string;
  state?: string;
  type?: string;
  model?: string;
  failure_code?: string;
  failure_reason?: string;
  output?: Array<{ type?: string; url?: string; layer?: unknown }>;
  detail?: unknown;
}

/** Render Luma's error payload as one line. `detail` is a string or a list. */
function describeError(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((e) => {
        const loc = Array.isArray((e as { loc?: unknown[] }).loc)
          ? (e as { loc: unknown[] }).loc.slice(1).join(".")
          : "";
        const msg = (e as { msg?: string }).msg ?? "";
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  return `HTTP ${status}`;
}

export interface LumaRunOptions {
  /**
   * Gap between polls. Defaults to POLL_INTERVAL_MS; tests pass a small value
   * so a suite of twenty cases does not spend a minute sleeping.
   */
  pollIntervalMs?: number;
}

export async function generateWithLuma(
  requestId: string,
  apiKey: string,
  input: GenerationInput,
  options: LumaRunOptions = {}
): Promise<GenerationOutput> {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const { model, type } = splitLumaModelId(input.model.id);
  const isVideo = !!type && VIDEO_TYPES.has(type);

  const body: Record<string, unknown> = { model };
  if (type) body.type = type;

  // Settings-panel parameters first, so a wired pin overrides a typed value.
  for (const [key, value] of Object.entries(input.parameters ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    setAtPath(body, key, value);
  }

  for (const [key, raw] of Object.entries(input.dynamicInputs ?? {})) {
    if (raw === null || raw === undefined || raw === "") continue;
    const shaped = shapeValue(key, raw);
    if (shaped === undefined) continue;
    setAtPath(body, key, shaped);
  }

  // Generic images[] land on image_ref unless a pin already filled it. For
  // image_edit the SOURCE is the thing being edited and arrives on its own pin;
  // these are style/content references, which is a different slot entirely.
  if (input.images?.length && body.image_ref === undefined) {
    const refs = input.images.map(toLumaImageRef).filter((r): r is LumaImageRef => !!r);
    if (refs.length) body.image_ref = refs;
  }

  // `prompt` is required on every request — including layering, where it may be
  // empty and simply lets the planner decide.
  if (typeof body.prompt !== "string") body.prompt = input.prompt ?? "";

  console.log(
    `[API:${requestId}] Luma submit model=${model} type=${type ?? "(default)"} keys=${Object.keys(body).join(", ")}`
  );

  let submitJson: LumaGeneration | null = null;
  try {
    const submit = await fetch(`${LUMA_API_BASE}/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await submit.text();
    try {
      submitJson = JSON.parse(text) as LumaGeneration;
    } catch {
      submitJson = null;
    }
    if (!submit.ok) {
      return { success: false, error: `${input.model.name}: ${describeError(submit.status, submitJson ?? text)}` };
    }
  } catch (err) {
    return { success: false, error: `${input.model.name}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const generationId = submitJson?.id;
  if (!generationId) {
    return { success: false, error: `${input.model.name}: No generation id in response` };
  }

  // ── Poll ───────────────────────────────────────────────────────────
  const deadline = Date.now() + GENERATION_MAX_WAIT_MS;
  let result: LumaGeneration | null = null;

  while (Date.now() < deadline) {
    // Luma has no cancel endpoint: stop polling, the job still runs and bills.
    if (await waitUnlessCancelled(pollIntervalMs, input.signal)) return cancelledOutput(requestId, "Luma", false);
    let poll: Response;
    try {
      poll = await fetch(`${LUMA_API_BASE}/generations/${generationId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      continue; // transient — keep polling until the deadline
    }
    if (!poll.ok) {
      if (poll.status === 429 || poll.status >= 500) continue;
      const body = await poll.json().catch(() => null);
      return { success: false, error: `${input.model.name}: ${describeError(poll.status, body)}` };
    }
    const json = (await poll.json().catch(() => null)) as LumaGeneration | null;
    if (!json) continue;

    if (json.state === "completed") {
      result = json;
      break;
    }
    if (json.state === "failed") {
      const why = json.failure_reason || json.failure_code || "generation failed";
      return { success: false, error: `${input.model.name}: ${why}` };
    }
  }

  if (!result) {
    return {
      success: false,
      error: `${input.model.name}: Timed out after ${Math.round(GENERATION_MAX_WAIT_MS / 60000)} minutes`,
    };
  }

  const entries = (result.output ?? []).filter((o) => !!o?.url);
  if (!entries.length) {
    return { success: false, error: `${input.model.name}: No outputs in generation result` };
  }

  // ── Download ───────────────────────────────────────────────────────
  // Presigned and valid for one hour, so fetch now rather than passing links on.
  const outputs: NonNullable<GenerationOutput["outputs"]> = [];
  for (const entry of entries) {
    const url = entry.url as string;
    const check = validateMediaUrl(url);
    if (!check.valid) {
      return { success: false, error: `${input.model.name}: Invalid output URL: ${check.error}` };
    }
    const resp = await fetch(url);
    if (!resp.ok) {
      return { success: false, error: `${input.model.name}: Failed to fetch output (${resp.status})` };
    }
    const declared = parseInt(resp.headers.get("content-length") || "0", 10);
    if (!isNaN(declared) && declared > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(declared / 1048576).toFixed(0)}MB > 500MB limit` };
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(buf.byteLength / 1048576).toFixed(0)}MB > 500MB limit` };
    }
    const mime = resp.headers.get("content-type")?.split(";")[0] || (isVideo ? "video/mp4" : "image/png");
    outputs.push({
      type: isVideo ? "video" : "image",
      data: `data:${mime};base64,${Buffer.from(buf).toString("base64")}`,
      url,
    });
  }

  console.log(`[API:${requestId}] Luma SUCCESS - ${outputs.length} output(s)`);
  return { success: true, outputs };
}
