"use client";

import { useEffect, useState } from "react";
import { getMediaDimensions } from "@/utils/nodeDimensions";

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
  /**
   * True when `media` is a thumbnail rather than the real asset. Measuring it
   * would report the thumbnail's size as the image's resolution, so without
   * stored dimensions the badge stays silent instead of stating a wrong number.
   */
  mediaIsThumb?: boolean;
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
export function MediaResolutionBadge({ media, storedDims, mediaIsThumb }: MediaResolutionBadgeProps) {
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

  // Measured a thumbnail with no recorded source size: say nothing rather than
  // report the thumbnail's own dimensions as the image's resolution.
  if (!storedDims && mediaIsThumb) return null;

  return (
    <div
      className="absolute bottom-1 right-1 z-10 px-1.5 py-[1px] rounded bg-black/60 text-[9px] leading-tight text-white/70 tabular-nums pointer-events-none select-none"
      title={`${dims.width} × ${dims.height} px`}
    >
      {dims.width} × {dims.height}
    </div>
  );
}
