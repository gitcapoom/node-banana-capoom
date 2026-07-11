"use client";

// The viewer is a standalone package (github.com/gitcapoom/splat-viewer),
// pulled in as a git dependency and transpiled via next.config
// `transpilePackages`. This route is a thin Next wrapper that renders it
// same-origin at /viewer, so the blob: splat URLs and the same-origin
// postMessage capture-back keep working.
import SplatViewer from "splat-viewer";

export default function ViewerPage() {
  return <SplatViewer />;
}
