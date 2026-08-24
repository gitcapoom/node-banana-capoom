"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useImageCropStore } from "@/store/imageCropStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { cropImageToDataUrl, type RelativeCropRegion } from "@/utils/cropImage";
import {
  buildCropMetadata,
  identityCropMetadata,
  serializeCropMetadata,
} from "@/utils/cropMetadata";
import type { ImageCropNodeData } from "@/types";
import { previewSrc } from "@/utils/nodePreview";
import { cheapUrlKey, RenderSignatureCache } from "@/utils/renderSignature";
import { commitProcessorOutput } from "@/store/execution/commitProcessorOutput";
import { useHydrateUnresolvedInputs, useIncomingEdgeKey } from "@/hooks/useUpstreamHydration";

type ImageCropNodeType = Node<ImageCropNodeData, "imageCrop">;

/**
 * Last applied (source + region) per node id.
 *
 * MODULE level, not a useRef, and that is the whole point. React Flow unmounts
 * nodes scrolled out of view; a per-instance ref died with the unmount, so the
 * guard was always empty on the way back and every pan that recrossed a crop
 * node re-ran a full-res decode + PNG encode — measured at ~1.5-3s per node,
 * and this graph has nine of them. CompNode's guard has been module-level for
 * exactly this reason.
 */
const committedCrops = new RenderSignatureCache();

/** The whole frame, relative — reads a source's real size through the
 *  full-frame short-circuit in `cropImageToDataUrl` (decode, no encode). */
const FULL_FRAME: RelativeCropRegion = { x: 0, y: 0, width: 1, height: 1 };

export function ImageCropNode({ id, data, selected }: NodeProps<ImageCropNodeType>) {
  const nodeData = data;
  const openModal = useImageCropStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const loadNodeFullResInputs = useWorkflowStore((state) => state.loadNodeFullResInputs);

  // Subscribe to live upstream output via a store selector so this node
  // re-renders when the upstream's outputImage changes — `edges` alone
  // doesn't catch that case.
  const incomingImage = useWorkflowStore((state) => {
    const ins = getConnectedInputsPure(id, state.nodes, state.edges, undefined, state.dimmedNodeIds);
    return ins.images[0] || null;
  });

  // Guards the in-flight promise against a newer one landing first. The
  // cross-remount dedup lives in `committedCrops` above.
  const inFlightRef = useRef<string>("");

  /** Identifies this node's incoming wiring. Lets the effect below tell "no edge"
   *  from "edge whose source has not been hydrated yet" — two states that look
   *  identical through `getSourceOutput`, which returns null for both. */
  const incomingEdgeKey = useIncomingEdgeKey(id);
  useHydrateUnresolvedInputs(id, incomingEdgeKey, !!nodeData.sourceImage);

  // 1) Mirror upstream image into sourceImage.
  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // 2) Auto-apply crop whenever sourceImage or cropRegion changes.
  // Deliberately does NOT depend on nodeData.outputImage — writing it back
  // would otherwise tear down the in-flight crop via dep change.
  useEffect(() => {
    const src = nodeData.sourceImage;
    const region = nodeData.cropRegion;

    if (!src) {
      // CONNECTED-BUT-UNHYDRATED is not DISCONNECTED, and this branch used to
      // conflate them.
      //
      // `imageInput.image` is a lazily-hydrated field (THUMB_DISPLAY_FIELDS in
      // imageFieldMap): on open it is null, the node paints its thumb — so it
      // looks perfectly loaded — and the full-res lives on disk behind
      // `imageRef`. `getSourceOutput` returns that null, so a crop wired to such
      // a node saw nothing and simply sat empty. The only thing that hydrated it
      // was this node's own Edit button, so the input never arrived until you
      // opened the editor. CompNode has always requested hydration from its
      // render effect for exactly this case; this makes the crop node agree.
      //
      // Reads as size-dependent from the outside, but is not: an image dragged in
      // during this session is still inline and works, while the same picture
      // reopened from the saved workflow is lazy and does not.
      //
      // The hydration request itself lives in useHydrateUnresolvedInputs above.
      if (incomingEdgeKey) {
        // Keep whatever is committed. Clearing here would throw away a good
        // saved output every time the workflow opened.
        return;
      }
      // Guarded on `outputImage` ALONE, deliberately. "No source" here means two
      // different things: genuinely disconnected, or a saved workflow whose
      // images are still lazily unloaded — and this branch cannot tell them
      // apart. On open both `sourceImage` and `outputImage` are null while
      // `cropMetadata` (inline in the workflow JSON, never externalized) is
      // present and CORRECT. Adding `|| cropMetadata !== null` therefore wiped
      // the metadata on every open of every saved crop: the downstream Comp's
      // align pin went null, its mirror no longer matched its stored
      // `compCommitSig`, and every aligned comp re-composited (1.0-1.8s each)
      // — with align blocked, so it published an un-aligned frame first.
      // `outputImage !== null` is the state that only exists AFTER hydration,
      // so it means "this node really has lost its input".
      if (nodeData.outputImage !== null) {
        updateNodeData(id, { outputImage: null, cropMetadata: null });
      }
      inFlightRef.current = "";
      committedCrops.forget(id);
      return;
    }

    // `cheapUrlKey`, not `src.length`. Two different images of equal byte
    // length collided on the old fingerprint and the node kept showing the
    // previous crop — a correctness bug, not just a perf one.
    const srcKey = cheapUrlKey(src);

    // No region → passthrough. Carry the source's thumb across as the output's
    // thumb (it IS a thumb of these exact pixels), so the preview has something
    // small to paint instead of the full-res source.
    if (!region) {
      const sig = `passthrough:${srcKey}`;
      // The metadata is part of what this pass has to have produced. The cache
      // is module-level and outlives the node's data, so an entry left by a
      // pass that ran before the metadata existed (or before a Reset cleared
      // it) would otherwise dedupe away the write that puts it back.
      if (committedCrops.matches(id, sig) && nodeData.outputImage === src && nodeData.cropMetadata) return;
      if (nodeData.outputImage !== src) {
        updateNodeData(id, {
          outputImage: src,
          outputImageRef: undefined,
          outputImageThumb: nodeData.sourceImageThumb,
          outputImageThumbKey: nodeData.sourceImageThumb ? srcKey : null,
        });
      }
      // Identity metadata needs the frame's real pixel size, which only a
      // decode knows. The image is published above regardless, so this costs a
      // decode (no encode) and never delays the pixels.
      inFlightRef.current = sig;
      cropImageToDataUrl(src, FULL_FRAME)
        .then(({ srcW, srcH }) => {
          if (inFlightRef.current !== sig) return;
          if (srcW <= 0 || srcH <= 0) return;
          committedCrops.set(id, sig);
          updateNodeData(id, {
            cropMetadata: serializeCropMetadata(identityCropMetadata(srcW, srcH)),
          });
        })
        .catch((err) => {
          // Not fatal: the passthrough image is already out. Leaving the sig
          // uncached means the next dep change retries the measurement.
          console.error("ImageCropNode: could not measure source", err);
        });
      return;
    }

    const fingerprint = `${srcKey}|${region.x}|${region.y}|${region.width}|${region.height}`;
    // Already produced this exact crop — a remount is not a reason to redo a
    // full-res decode and PNG encode. `cropMetadata` is part of the product,
    // for the same reason as in the passthrough branch above.
    if (committedCrops.matches(id, fingerprint) && nodeData.outputImage && nodeData.cropMetadata) return;
    inFlightRef.current = fingerprint;

    cropImageToDataUrl(src, region)
      .then((result) => {
        if (inFlightRef.current !== fingerprint) return;
        committedCrops.set(id, fingerprint);
        // commitProcessorOutput writes the display thumb beside the output.
        // Writing the output raw is what left this node with nothing but a
        // full-res image to paint into a ~90px box.
        void commitProcessorOutput(updateNodeData, id, result.dataUrl, {
          // From the CropResult, so the integers are the ones drawImage got.
          cropMetadata: serializeCropMetadata(buildCropMetadata(result, region)),
        } as Partial<ImageCropNodeData>);
      })
      .catch((err) => {
        console.error("ImageCropNode: crop failed", err);
        if (inFlightRef.current !== fingerprint) return;
        // No honest geometry to publish for a frame that would not decode.
        updateNodeData(id, { outputImage: src, cropMetadata: null });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.sourceImage, nodeData.cropRegion, updateNodeData, incomingEdgeKey]);

  const handleEdit = useCallback(async () => {
    // The source mirrors upstream; on reopen it's lazily null. Load the
    // upstream full-res, then read the freshly-mirrored input. (We can't just
    // load this node's own stored sourceImage — the mirror effect would null it
    // back when the upstream is empty.)
    await loadNodeFullResInputs(id);
    const s = useWorkflowStore.getState();
    const ins = getConnectedInputsPure(id, s.nodes, s.edges, undefined, s.dimmedNodeIds);
    const src = ins.images[0] || nodeData.sourceImage || null;
    if (!src) {
      alert("No image available. Connect an image input.");
      return;
    }
    openModal(id, src, nodeData.cropRegion ?? null, nodeData.aspectLock ?? "free");
  }, [id, loadNodeFullResInputs, nodeData.sourceImage, nodeData.cropRegion, nodeData.aspectLock, openModal]);

  const handleReset = useCallback(() => {
    updateNodeData(id, {
      cropRegion: null,
      outputImage: nodeData.sourceImage,
      // Describes the crop that just went away. The effect re-emits the
      // identity payload once it has measured the source again.
      cropMetadata: null,
    });
  }, [id, nodeData.sourceImage, updateNodeData]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      sourceImageRef: undefined,
      outputImage: null,
      outputImageRef: undefined,
      cropRegion: null,
      cropMetadata: null,
    });
  }, [id, updateNodeData]);

  // The output thumb is trustworthy the moment its key matches the output it
  // was made from — the ref is cleared on every crop by design, so without this
  // the node painted the full-res crop (up to ~10MP) into a ~90px box from the
  // first edit until the next save.
  const outThumbCurrent =
    !!nodeData.outputImage && nodeData.outputImageThumbKey === cheapUrlKey(nodeData.outputImage);
  const displayImage =
    previewSrc(nodeData.outputImage, nodeData.outputImageThumb, nodeData.outputImageRef, outThumbCurrent) ||
    previewSrc(nodeData.sourceImage, nodeData.sourceImageThumb, nodeData.sourceImageRef);

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
      // Thumb first: this only needs an ASPECT RATIO (and feeds the resolution
      // badge, which reads the persisted *Dims anyway), so referencing the
      // full-res image here just kept it alive on the render path.
      aspectFitMedia={displayImage}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
        style={{ top: "35%" }}
      />
      {/* Placement metadata JSON — same image+text output pair as PanoCrop.
          Off-centre so the two source pins stay separately clickable. */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
        style={{ top: "65%" }}
      />

      {displayImage ? (
        <div className="relative group w-full h-full" onDoubleClick={handleEdit}>
          <img
            src={displayImage}
            alt="Cropped"
            className="w-full h-full object-contain"
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); handleEdit(); }}
              className="nodrag nopan text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1.5 rounded pointer-events-auto cursor-pointer hover:bg-black/80"
            >
              {nodeData.cropRegion ? "Edit crop" : "Define crop"}
            </button>
            {nodeData.cropRegion && (
              <button
                onClick={(e) => { e.stopPropagation(); handleReset(); }}
                className="nodrag nopan text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1.5 rounded pointer-events-auto cursor-pointer hover:bg-black/80"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>
  );
}
