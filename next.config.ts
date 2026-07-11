import type { NextConfig } from "next";

// The splat viewer is NOT compiled into this app (Option A distribution).
// One hosted Vite build — served by the render-tracking-viewer's Caddy at
// http://OTOSERVE10:8080/_viewer/ — is reverse-proxied here under our own
// origin, so blob: splat URLs, the sessionStorage state handoff, and the
// same-origin postMessage capture-back all keep working unchanged.
// Override the host with SPLAT_VIEWER_ORIGIN if the hosted build moves.
const SPLAT_VIEWER_ORIGIN = process.env.SPLAT_VIEWER_ORIGIN ?? "http://OTOSERVE10:8080";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["otoserve10", "otoserve10:3000", "otoserve10:3001"],
  reactStrictMode: true,
  serverExternalPackages: ["sharp"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  turbopack: {
    root: __dirname,
  },
  async rewrites() {
    return [
      // Bare /viewer (no app route — the old page.tsx wrapper was removed)
      // serves the hosted build's index.html; query params (?url=&worldId=…)
      // pass through untouched. Scoped to EXACTLY /viewer: a catch-all
      // /viewer/:path* would shadow the dynamic /viewer/[worldId] app route
      // (afterFiles rewrites run before dynamic routes). /viewer/pano is a
      // static app route and wins over these rewrites regardless.
      { source: "/viewer", destination: `${SPLAT_VIEWER_ORIGIN}/_viewer/index.html` },
      // The build's asset URLs are relative (./assets/*, base:"./"). Relative
      // to the document URL /viewer they resolve to root-level /assets/* —
      // proxy that namespace to the hosted build's assets. (Nothing else in
      // this app serves /assets: no public/assets, no app route.)
      { source: "/assets/:path*", destination: `${SPLAT_VIEWER_ORIGIN}/_viewer/assets/:path*` },
    ];
  },
  // NOTE: next.config `headers()` does NOT apply to externally-rewritten
  // (proxied) responses, so cache headers can't be added here. Stale-build
  // protection instead: the openers (SpzViewerNode / WorldLabsWorldNode)
  // append a `_cb=Date.now()` cache-buster to the /viewer URL, and the
  // build's assets are content-hashed.
};

export default nextConfig;
