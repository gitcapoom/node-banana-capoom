/**
 * Server-Sent Events helpers for /api/generate.
 *
 * The generate route accepts `Accept: text/event-stream` to opt into a
 * streaming response. While the server is polling the upstream provider
 * (fal/replicate/kie/muapi/wavespeed) it emits status events back to the
 * client every poll iteration:
 *
 *   event: status
 *   data: {"phase":"queued","queuePosition":3,"elapsedMs":4200}
 *
 *   event: status
 *   data: {"phase":"running","queuePosition":null,"elapsedMs":12000}
 *
 *   event: result
 *   data: { ...GenerateResponse... }
 *
 * Clients that omit the Accept header get the existing blocking JSON
 * response — no behaviour change.
 */

export type GenerateStatusPhase =
  | "submitting"      // Building the request body, uploading inputs
  | "queued"          // Provider has the job but hasn't started
  | "running"         // Provider is actively processing
  | "downloading";    // Final asset transfer in progress

export interface GenerateStatusUpdate {
  phase: GenerateStatusPhase;
  /** Position in the provider's queue when known (fal only at the moment).
   *  null when the provider doesn't expose it or the job is already running. */
  queuePosition?: number | null;
  /** Server-side elapsed ms since the SSE stream opened — clients can
   *  use this OR their own local timer; we send it for parity. */
  elapsedMs?: number;
  /** Optional human-readable message ("In queue: position 3"). */
  message?: string;
}

export type StatusCallback = (update: GenerateStatusUpdate) => void;

/** Returns true if the request opted into SSE via the Accept header. */
export function wantsSSE(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.toLowerCase().includes("text/event-stream");
}

/**
 * Build a TransformStream-shaped SSE controller. Pass it to a
 * `new Response(stream, { headers: SSE_HEADERS })`.
 *
 * Usage:
 *   const { stream, emit, finish } = createSSEStream();
 *   (async () => {
 *     try {
 *       const result = await provider.generate({ onStatus: emit("status") });
 *       finish("result", result);
 *     } catch (err) {
 *       finish("error", { error: String(err) });
 *     }
 *   })();
 *   return new Response(stream, { headers: SSE_HEADERS });
 */
export function createSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  emit: (eventName: string, data: unknown) => void;
  finish: (eventName: string, data: unknown) => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
    },
  });

  const write = (eventName: string, data: unknown) => {
    if (!controller) return;
    const payload = JSON.stringify(data);
    const chunk = `event: ${eventName}\ndata: ${payload}\n\n`;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // Stream might have been cancelled by the client; ignore.
    }
  };

  return {
    stream,
    emit: write,
    finish: (eventName: string, data: unknown) => {
      write(eventName, data);
      if (controller) {
        try { controller.close(); } catch { /* already closed */ }
        controller = null;
      }
    },
  };
}

export const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  // Disable buffering at Vercel / NGINX so events flush in real time
  "X-Accel-Buffering": "no",
};
