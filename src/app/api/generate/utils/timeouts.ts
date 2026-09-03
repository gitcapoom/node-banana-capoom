/**
 * How long a generation may run before the server gives up polling.
 *
 * This was previously a magic number repeated in every provider, and they had
 * drifted apart: wavespeed and Gemini/Veo gave up at 5 minutes, fal and kie at
 * 10, muapi at 20, and replicate used 5 or 10 depending on whether the model
 * declared a video capability. A slow-but-healthy job therefore failed or
 * succeeded purely according to which provider happened to serve it.
 *
 * One constant, so raising the ceiling is a single edit.
 *
 * The outer bounds this has to sit inside:
 *   - `server.requestTimeout` in server.js — 25 min, the real local limit.
 *   - `maxDuration` in the route — Vercel only, no effect on a local server,
 *     but kept consistent so a deployed instance behaves the same.
 * Both must stay LONGER than this value, or the socket dies before the poll
 * loop can report a clean timeout and the user gets a network error instead of
 * a real message.
 */
export const GENERATION_MAX_WAIT_MS = 20 * 60 * 1000; // 20 minutes

/** Same value in seconds, for route `maxDuration` declarations. */
export const GENERATION_MAX_WAIT_SECONDS = GENERATION_MAX_WAIT_MS / 1000;
