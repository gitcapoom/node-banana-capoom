"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Transformer, Group } from "react-konva";
import Konva from "konva";
import { useImageCropStore, type CropRegion } from "@/store/imageCropStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { ImageCropAspectLock } from "@/types";

const ASPECT_PRESETS: { key: ImageCropAspectLock; label: string; ratio: number | null }[] = [
  { key: "free",  label: "Free",  ratio: null },
  { key: "1:1",   label: "1:1",   ratio: 1 },
  { key: "16:9",  label: "16:9",  ratio: 16 / 9 },
  { key: "9:16",  label: "9:16",  ratio: 9 / 16 },
  { key: "4:3",   label: "4:3",   ratio: 4 / 3 },
  { key: "3:4",   label: "3:4",   ratio: 3 / 4 },
];

function ratioFor(aspect: ImageCropAspectLock): number | null {
  const entry = ASPECT_PRESETS.find((a) => a.key === aspect);
  return entry ? entry.ratio : null;
}

export function ImageCropModal() {
  const {
    isModalOpen,
    sourceNodeId,
    sourceImage,
    cropRegion,
    aspectLock,
    closeModal,
    setCropRegion,
    setAspectLock,
    reset,
    undo,
    redo,
  } = useImageCropStore();

  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const stageRef = useRef<Konva.Stage>(null);
  const rectRef = useRef<Konva.Rect>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Load image + compute fit
  useEffect(() => {
    if (!isModalOpen || !sourceImage) {
      setImage(null);
      return;
    }
    const img = new window.Image();
    if (!sourceImage.startsWith("data:") && !sourceImage.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      setImage(img);
      if (containerRef.current) {
        const cw = containerRef.current.clientWidth - 80;
        const ch = containerRef.current.clientHeight - 80;
        const s = Math.min(cw / img.width, ch / img.height, 1);
        setScale(s);
        setStageSize({ width: img.width, height: img.height });
        setPosition({
          x: (cw - img.width * s) / 2 + 40,
          y: (ch - img.height * s) / 2 + 40,
        });
      }
    };
    img.src = sourceImage;
  }, [isModalOpen, sourceImage]);

  // Initialize default crop if no existing region
  useEffect(() => {
    if (!isModalOpen || !image) return;
    if (!cropRegion) {
      // Default crop: 80% of image centered, respecting aspect lock
      const ratio = ratioFor(aspectLock);
      let w = 0.8;
      let h = 0.8;
      if (ratio) {
        // Fit ratio within 0.8x0.8 box
        const imgRatio = image.width / image.height;
        const effRatio = ratio / imgRatio; // ratio in relative coords
        if (effRatio > 1) {
          // wider than image → limit width
          w = 0.8;
          h = w / effRatio;
        } else {
          h = 0.8;
          w = h * effRatio;
        }
      }
      const x = (1 - w) / 2;
      const y = (1 - h) / 2;
      setCropRegion({ x, y, width: w, height: h });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, image]);

  // Attach transformer to rect
  useEffect(() => {
    if (transformerRef.current && rectRef.current) {
      transformerRef.current.nodes([rectRef.current]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [image, cropRegion]);

  // Keyboard handlers
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === "Escape") {
        closeModal();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
        e.preventDefault();
        redo();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, closeModal, undo, redo]);

  const handleAspectChange = useCallback(
    (lock: ImageCropAspectLock) => {
      setAspectLock(lock);
      if (!image || !cropRegion) return;
      const ratio = ratioFor(lock);
      if (!ratio) return; // free — leave region unchanged
      // Adjust current region to match ratio, centered on current center
      const imgRatio = image.width / image.height;
      const effRatio = ratio / imgRatio;
      const cx = cropRegion.x + cropRegion.width / 2;
      const cy = cropRegion.y + cropRegion.height / 2;
      let w = cropRegion.width;
      let h = w / effRatio;
      if (h > 1) {
        h = 1;
        w = h * effRatio;
      }
      const x = Math.max(0, Math.min(1 - w, cx - w / 2));
      const y = Math.max(0, Math.min(1 - h, cy - h / 2));
      setCropRegion({ x, y, width: w, height: h });
    },
    [image, cropRegion, setAspectLock, setCropRegion]
  );

  const handleApply = useCallback(() => {
    if (!sourceNodeId) return;
    updateNodeData(sourceNodeId, {
      cropRegion,
      aspectLock,
    });
    closeModal();
  }, [sourceNodeId, cropRegion, aspectLock, updateNodeData, closeModal]);

  // Convert relative region to Konva pixel box (on the stage, not scaled)
  const regionToBox = (r: CropRegion | null) => {
    if (!r || !image) return null;
    return {
      x: r.x * image.width,
      y: r.y * image.height,
      width: r.width * image.width,
      height: r.height * image.height,
    };
  };

  // Update store from dragged/transformed rect
  const handleRectTransform = () => {
    const node = rectRef.current;
    if (!node || !image) return;
    // Apply scale to width/height then reset scale (Konva Transformer convention)
    const sx = node.scaleX();
    const sy = node.scaleY();
    const w = Math.max(1, node.width() * sx);
    const h = Math.max(1, node.height() * sy);
    node.scaleX(1);
    node.scaleY(1);
    node.width(w);
    node.height(h);

    // Clamp to image bounds
    const x = Math.max(0, Math.min(image.width - w, node.x()));
    const y = Math.max(0, Math.min(image.height - h, node.y()));
    node.x(x);
    node.y(y);

    setCropRegion({
      x: x / image.width,
      y: y / image.height,
      width: w / image.width,
      height: h / image.height,
    });
  };

  const handleRectDragEnd = () => {
    const node = rectRef.current;
    if (!node || !image) return;
    const w = node.width();
    const h = node.height();
    const x = Math.max(0, Math.min(image.width - w, node.x()));
    const y = Math.max(0, Math.min(image.height - h, node.y()));
    node.x(x);
    node.y(y);
    setCropRegion({
      x: x / image.width,
      y: y / image.height,
      width: w / image.width,
      height: h / image.height,
    });
  };

  if (!isModalOpen) return null;

  const cropBox = regionToBox(cropRegion);
  const pxW = cropBox ? Math.round(cropBox.width) : 0;
  const pxH = cropBox ? Math.round(cropBox.height) : 0;
  const srcW = image?.width ?? 0;
  const srcH = image?.height ?? 0;

  return (
    <div className="fixed inset-0 bg-neutral-950/95 z-[100] flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
      {/* Top Bar */}
      <div className="h-12 bg-neutral-900 border-b border-neutral-800 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white">Image Crop</span>
          <span className="text-[11px] text-neutral-500 ml-3">
            {srcW > 0 && srcH > 0 ? `Source: ${srcW}×${srcH}` : "Loading..."}
          </span>
          {cropBox && (
            <span className="text-[11px] text-neutral-400 ml-3">
              Output: {pxW}×{pxH}
            </span>
          )}

          <div className="w-px h-6 bg-neutral-700 mx-4" />

          {/* Aspect presets */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide mr-1">Ratio</span>
            {ASPECT_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => handleAspectChange(p.key)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  aspectLock === p.key
                    ? "bg-indigo-600 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="w-px h-6 bg-neutral-700 mx-3" />

          <button onClick={undo} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Undo</button>
          <button onClick={redo} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Redo</button>

          <div className="w-px h-6 bg-neutral-700 mx-3" />

          <button onClick={reset} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-red-400">Reset</button>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={closeModal} className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white">
            Cancel
          </button>
          <button onClick={handleApply} className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200">
            Apply
          </button>
        </div>
      </div>

      {/* Canvas Container */}
      <div ref={containerRef} className="flex-1 overflow-hidden bg-neutral-900">
        {image && (
          <Stage
            ref={stageRef}
            width={containerRef.current?.clientWidth || 800}
            height={containerRef.current?.clientHeight || 600}
            scaleX={scale}
            scaleY={scale}
            x={position.x}
            y={position.y}
          >
            <Layer>
              <KonvaImage image={image} width={stageSize.width} height={stageSize.height} />

              {/* Dimmed overlay outside the crop region */}
              {cropBox && (
                <Group>
                  {/* Top */}
                  <Rect x={0} y={0} width={stageSize.width} height={cropBox.y} fill="black" opacity={0.55} listening={false} />
                  {/* Bottom */}
                  <Rect x={0} y={cropBox.y + cropBox.height} width={stageSize.width} height={stageSize.height - (cropBox.y + cropBox.height)} fill="black" opacity={0.55} listening={false} />
                  {/* Left */}
                  <Rect x={0} y={cropBox.y} width={cropBox.x} height={cropBox.height} fill="black" opacity={0.55} listening={false} />
                  {/* Right */}
                  <Rect x={cropBox.x + cropBox.width} y={cropBox.y} width={stageSize.width - (cropBox.x + cropBox.width)} height={cropBox.height} fill="black" opacity={0.55} listening={false} />
                </Group>
              )}

              {/* Crop rectangle */}
              {cropBox && (
                <Rect
                  ref={rectRef}
                  x={cropBox.x}
                  y={cropBox.y}
                  width={cropBox.width}
                  height={cropBox.height}
                  stroke="#fff"
                  strokeWidth={2 / scale}
                  draggable
                  onDragEnd={handleRectDragEnd}
                  onTransformEnd={handleRectTransform}
                />
              )}

              {/* Transformer for resize handles */}
              <Transformer
                ref={transformerRef}
                rotateEnabled={false}
                keepRatio={aspectLock !== "free"}
                enabledAnchors={[
                  "top-left", "top-center", "top-right",
                  "middle-left", "middle-right",
                  "bottom-left", "bottom-center", "bottom-right",
                ]}
                anchorFill="#fff"
                anchorStroke="#0ea5e9"
                anchorStrokeWidth={1}
                borderEnabled={false}
                boundBoxFunc={(oldBox, newBox) => {
                  if (!image) return oldBox;
                  // Clamp to image bounds
                  const minSize = 10;
                  if (newBox.width < minSize || newBox.height < minSize) return oldBox;
                  if (newBox.x < 0 || newBox.y < 0) return oldBox;
                  if (newBox.x + newBox.width > image.width) return oldBox;
                  if (newBox.y + newBox.height > image.height) return oldBox;
                  return newBox;
                }}
              />
            </Layer>
          </Stage>
        )}
      </div>
    </div>
  );
}
