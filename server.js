// Custom Next.js server with extended timeout for video generation
// Node.js default server.requestTimeout is 5 minutes (300,000ms)
// We extend it to 25 minutes for long-running video generation (muapi/fal)

const { createServer } = require('http');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = (process.env.PORT || '3000').trim();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Schema warmer — POSTs to /api/_internal/warm-schemas every 24h.
// First run happens ~15s after boot so Next has finished wiring routes.
const WARM_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WARM_INITIAL_DELAY_MS = 15 * 1000;
function triggerSchemaWarm(reason) {
  const hostForWarm = hostname === '0.0.0.0' ? '127.0.0.1' : hostname;
  const url = `http://${hostForWarm}:${port}/api/_internal/warm-schemas`;
  const started = Date.now();
  console.log(`[schema-warmer] Triggering warm (${reason}) → ${url}`);
  fetch(url, { method: 'POST' })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (body && body.report) {
        const r = body.report;
        console.log(
          `[schema-warmer] ${body.status}: ${r.successful}/${r.total} ok, ` +
          `${r.failed} failed, ${r.playgroundAugmented} augmented, ` +
          `${Math.round((Date.now() - started) / 1000)}s elapsed`
        );
      } else {
        console.log(`[schema-warmer] status=${body?.status ?? res.status}`);
      }
    })
    .catch((err) => {
      console.warn(`[schema-warmer] trigger failed:`, err && err.message ? err.message : err);
    });
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    await handle(req, res);
  });

  // Increase timeout to 25 minutes for long-running video generation (muapi/fal)
  server.requestTimeout = 1500000; // 25 minutes
  server.headersTimeout = 1510000; // Slightly longer than requestTimeout

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port} (accessible on LAN via your machine's IP)`);
    console.log(`> Server timeout set to ${server.requestTimeout / 1000 / 60} minutes`);

    // Kick off schema warming on boot + every 24h.
    setTimeout(() => triggerSchemaWarm('startup'), WARM_INITIAL_DELAY_MS);
    setInterval(() => triggerSchemaWarm('24h cron'), WARM_INTERVAL_MS);
  });
});
