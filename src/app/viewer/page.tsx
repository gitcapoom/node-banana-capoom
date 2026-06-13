"use client";

// The viewer source now lives in the shared splat-viewer subtree
// (src/splat-viewer, mirror of github.com/gitcapoom/splat-viewer). This route
// is a thin Next wrapper that renders it same-origin at /viewer, so the blob:
// splat URLs and the same-origin postMessage capture-back keep working.
import SplatViewer from "@/splat-viewer/src/SplatViewer";

export default function ViewerPage() {
  return <SplatViewer />;
}
