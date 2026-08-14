"use client";

import { useEffect, useState } from "react";
import { getMediaDimensions } from "@/utils/nodeDimensions";
import { THUMB_MAX_DIM } from "@/utils/createImageThumbnail";

export interface Dims {
  width: number;
  height: number;
}

interface MediaResolutionBadgeProps {
  /** The media currently shown in the node — full-res or thumbnail. */
  media: string | null | undefined;
  /**
   * Source dimensions recorded when the thumbnail was written (see
   * createImageThumbnailWithMeta). Preferred over measuring, because after a
   * reload `media` is only the downscaled thumb.
   */
  storedDims?: Dims | null;
}

/**
 * Small "1920 × 1080" readout pinned to the corner of a node's preview.
 *
 * Resolution is the thing you most often need to know about an image mid-graph
 * — whether the reformat took, what a generator actually returned, whether a
 * matte matches its plate — and it was previously only discoverable by opening
 * the image.
 *
 * Measuring the displayed media is not enough on its own: workflows reopen with
 * only a 236px thumbnail in memory, and measuring that would confidently report
 * the wrong number. So stored dimensions win when present, and a measurement
 * that comes back no larger than a thumbnail is suppressed rather than shown as
 * fact.
 */
export function MediaResolutionBadge({ media, storedDims }: MediaResolutionBadgeProps) {
  const [measured, setMeasured] = useState<Dims | null>(null);

  useEffect(() => {
    if (!media || storedDims) { setMeasured(null); return; }
    let cancelled = false;
    void getMediaDimensions(media).then((d) => {
      if (!cancelled) setMeasured(d);
    });
    return () => { cancelled = true; };
  }, [media, storedDims]);

  const dims = storedDims ?? measured;
  if (!dims || dims.width <= 0 || dims.height <= 0) return null;

  // A measurement at or below the thumbnail cap is almost certainly the thumb
  // itself, not the real asset — report nothing rather than something false.
  if (!storedDims && Math.max(dims.width, dims.height) <= THUMB_MAX_DIM) return null;

  return (
    <div
      className="absolute bottom-1 right-1 z-10 px-1.5 py-[1px] rounded bg-black/60 text-[9px] leading-tight text-white/70 tabular-nums pointer-events-none select-none"
      title={`${dims.width} × ${dims.height} px`}
    >
      {dims.width} × {dims.height}
    </div>
  );
}
