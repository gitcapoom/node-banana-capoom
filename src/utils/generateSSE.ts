/**
 * Client helper for consuming the /api/generate SSE stream.
 *
 * Opt in by setting `Accept: text/event-stream` on the POST. The server
 * returns a stream of events:
 *
 *   event: status
 *   data: { phase, queuePosition?, elapsedMs? }
 *
 *   event: result
 *   data: { success, image | video | audio | model3d, ... }   (final)
 *
 * On any non-SSE response (older server, or provider that hasn't been
 * wired to SSE yet), the caller can fall back to `response.json()`.
 */

export interface GenerateSSEStatus {
  phase: "submitting" | "queued" | "running" | "downloading";
  queuePosition?: number | null;
  elapsedMs?: number;
  message?: string;
}

export interface GenerateSSEResult {
  success: boolean;
  error?: string;
  // Whatever fields /api/generate's JSON normally returns — left untyped
  // here because the response shape varies per provider/media-type and we
  // hand the body straight back to the caller's existing handler.
  [k: string]: unknown;
}

/** True when the response is an SSE stream we should parse event-by-event. */
export function isSSEResponse(response: Response): boolean {
  const ct = response.headers.get("content-type") || "";
  return ct.toLowerCase().includes("text/event-stream");
}

/**
 * Read the SSE body and call `onStatus` for each `event: status` chunk.
 * Resolves with the parsed `event: result` payload. Rejects if the stream
 * ends without a result event (e.g. server crashed mid-stream).
 */
export async function consumeGenerateSSE(
  response: Response,
  onStatus: (s: GenerateSSEStatus) => void,
): Promise<GenerateSSEResult> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Standard SSE parsing — events end with a blank line, each event has
  // an `event: ...` line and one or more `data: ...` lines (we
  // concatenate). We only care about `status` and `result` event names.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIdx;
    while ((separatorIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIdx);
      buffer = buffer.slice(separatorIdx + 2);

      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      const dataStr = dataLines.join("\n");
      if (!dataStr) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(dataStr);
      } catch (err) {
        console.warn("[generateSSE] failed to parse event data, skipping", err, dataStr.slice(0, 200));
        continue;
      }

      if (eventName === "status") {
        onStatus(parsed as GenerateSSEStatus);
      } else if (eventName === "result") {
        return parsed as GenerateSSEResult;
      }
    }
  }

  throw new Error("SSE stream ended without a result event");
}
