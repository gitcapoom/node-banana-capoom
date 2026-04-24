"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageInputNodeData } from "@/types";
import { MediaOverlay } from "../MediaOverlay";
import { deriveAutoTitle } from "@/utils/nodeTitleFromFilename";
import { mirrorImage } from "@/utils/mirrorImage";

type ImageInputNodeType = Node<ImageInputNodeData, "imageInput">;

export function ImageInputNode({ id, data, selected }: NodeProps<ImageInputNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showOverlay, setShowOverlay] = useState(false);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.match(/^image\/(png|jpeg|webp)$/)) {
        alert("Unsupported format. Use PNG, JPG, or WebP.");
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        alert("Image too large. Maximum size is 10MB.");
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        const img = new Image();
        img.onload = () => {
          const customTitle = deriveAutoTitle(
            file.name,
            nodeData.filename,
            (nodeData as ImageInputNodeData & { customTitle?: string }).customTitle
          );
          updateNodeData(id, {
            image: base64,
            imageRef: undefined,
            filename: file.name,
            dimensions: { width: img.width, height: img.height },
            ...(customTitle !== undefined ? { customTitle } : {}),
          });
        };
        img.src = base64;
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData, nodeData]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      image: null,
      imageRef: undefined,
      filename: null,
      dimensions: null,
      outputImage: null,
      outputImageRef: undefined,
    });
  }, [id, updateNodeData]);

  const toggleFlipH = useCallback(() => {
    updateNodeData(id, { flipHorizontal: !nodeData.flipHorizontal });
  }, [id, nodeData.flipHorizontal, updateNodeData]);

  const toggleFlipV = useCallback(() => {
    updateNodeData(id, { flipVertical: !nodeData.flipVertical });
  }, [id, nodeData.flipVertical, updateNodeData]);

  // Re-render the mirrored outputImage whenever source or flip toggles change.
  // Stored on the node so `getSourceOutput` can return it synchronously.
  const lastFlipApplied = useRef<string>("");
  useEffect(() => {
    const src = nodeData.image;
    const h = !!nodeData.flipHorizontal;
    const v = !!nodeData.flipVertical;

    if (!src) {
      if (nodeData.outputImage !== null && nodeData.outputImage !== undefined) {
        updateNodeData(id, { outputImage: null });
      }
      lastFlipApplied.current = "";
      return;
    }

    if (!h && !v) {
      // No flip — clear the rendered copy (downstream will use `image`)
      if (nodeData.outputImage) {
        updateNodeData(id, { outputImage: null });
      }
      lastFlipApplied.current = `passthrough:${src.length}`;
      return;
    }

    const fingerprint = `${src.length}|${h ? "H" : ""}${v ? "V" : ""}`;
    if (lastFlipApplied.current === fingerprint) return;
    lastFlipApplied.current = fingerprint;

    let cancelled = false;
    mirrorImage(src, h, v)
      .then((flipped) => {
        if (!cancelled) updateNodeData(id, { outputImage: flipped, outputImageRef: undefined });
      })
      .catch((err) => {
        console.error("ImageInputNode: mirror failed", err);
      });

    return () => {
      cancelled = true;
    };
  }, [id, nodeData.image, nodeData.flipHorizontal, nodeData.flipVertical, nodeData.outputImage, updateNodeData]);

  const displayImage =
    (nodeData.flipHorizontal || nodeData.flipVertical) && nodeData.outputImage
      ? nodeData.outputImage
      : nodeData.image;

  // No-op handlers for overlay (single image, no carousel)
  const noop = useCallback(() => {}, []);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
      aspectFitMedia={nodeData.image}
      fullBleed
    >
      {/* Reference input handle for visual links from Split Grid node */}
      <Handle
        type="target"
        position={Position.Left}
        id="reference"
        data-handletype="reference"
        className="!bg-gray-500"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.image ? (
        <div className="relative group w-full h-full">
          <img
            src={displayImage || nodeData.image}
            alt={nodeData.filename || "Uploaded image"}
            className="w-full h-full object-contain cursor-pointer"
            onDoubleClick={(e) => { e.stopPropagation(); setShowOverlay(true); }}
          />
          {/* Mirror toggles — bottom-left, fade in on hover */}
          <div className="absolute bottom-2 left-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity nodrag">
            <button
              onClick={(e) => { e.stopPropagation(); toggleFlipH(); }}
              aria-label="Flip horizontal"
              title="Flip horizontally"
              className={`w-6 h-6 rounded text-white text-xs flex items-center justify-center transition-colors ${
                nodeData.flipHorizontal
                  ? "bg-blue-600/90 hover:bg-blue-500"
                  : "bg-black/60 hover:bg-black/80"
              }`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7l-5 5 5 5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7l5 5-5 5" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); toggleFlipV(); }}
              aria-label="Flip vertical"
              title="Flip vertically"
              className={`w-6 h-6 rounded text-white text-xs flex items-center justify-center transition-colors ${
                nodeData.flipVertical
                  ? "bg-blue-600/90 hover:bg-blue-500"
                  : "bg-black/60 hover:bg-black/80"
              }`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8l5-5 5 5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16l5 5 5-5" />
              </svg>
            </button>
          </div>
          <button
            onClick={handleRemove}
            aria-label="Remove image"
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 focus:ring-1 focus:ring-red-400 transition-all flex items-center justify-center"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {/* Double-click hint */}
          <div className="absolute bottom-0 left-0 right-0 text-center py-1 bg-neutral-900/40 pointer-events-none">
            <span className="text-[10px] text-white/30">double click to view</span>
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload image"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/60 transition-colors"
        >
          <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <span className="text-xs text-neutral-500 mt-2">Drop image</span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
      />
    </BaseNode>

    {showOverlay && nodeData.image && (
      <MediaOverlay
        content={displayImage || nodeData.image}
        mediaType="image"
        currentIndex={0}
        totalCount={1}
        onPrevious={noop}
        onNext={noop}
        onClose={() => setShowOverlay(false)}
      />
    )}
    </>
  );
}
