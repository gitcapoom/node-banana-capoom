"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Transformer, Group } from "react-konva";
import { zoomStageAtPointer } from "@/utils/konvaStageZoom";
import { commitProcessorOutput } from "@/store/execution/commitProcessorOutput";
import Konva from "konva";
import { useImageCropStore, type CropRegion } from "@/store/imageCropStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { cropImageToDataUrl } from "@/utils/cropImage";
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
  // Wheel-zoom and space-drag pan, the same as the mask / annotation / comp
  // editors. Without them this modal could only ever show the fit-to-window
  // view, which is no use for placing a crop edge on a large frame.
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) { e.preventDefault(); setSpaceHeld(true); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // zoomStageAtPointer drives the Konva stage directly (cursor-anchored); the
  // stage is React-controlled here, so read the result back into state.
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    zoomStageAtPointer(stage, e.evt.deltaY, { min: 0.05, max: 20 });
    setScale(stage.scaleX());
    setPosition({ x: stage.x(), y: stage.y() });
  }, []);

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

  // "AD" preset — horizontal resolution = source width ÷ 3 × 2; vertical
  // resolution = 16:9 of that horizontal resolution; crop centered. Computed
  // in source pixels, then stored as a relative (0–1) region.
  const handleAdPreset = useCallback(() => {
    if (!image) return;
    const srcW = image.width;
    const srcH = image.height;
    const hRes = (srcW / 3) * 2;   // horizontal resolution
    const vRes = hRes * (9 / 16);  // 16:9 of the horizontal resolution
    let w = hRes / srcW;           // relative width (= 2/3)
    let h = vRes / srcH;           // relative height
    if (h > 1) {                   // ultra-wide source: keep 16:9, fit to height
      h = 1;
      w = (srcH * (16 / 9)) / srcW;
    }
    setAspectLock("16:9");
    setCropRegion({ x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h });
  }, [image, setAspectLock, setCropRegion]);

  const handleApply = useCallback(async () => {
    if (!sourceNodeId) return;

    // Compute the cropped data URL synchronously here so downstream nodes see
    // the new `outputImage` in the same update as `cropRegion`/`aspectLock`.
    // Previously we wrote only the region and trusted ImageCropNode's effect
    // to recompute via `cropImageToDataUrl`, but the effect's fingerprint
    // dedup and async resolve could leave the output stale for downstream
    // consumers (which read `nodeData.outputImage` directly).
    //
    // If there's no region, fall back to passthrough (source as output).
    // On crop failure, also fall back so we never block the modal.
    let outputImage: string | null = sourceImage;
    if (sourceImage && cropRegion) {
      try {
        outputImage = await cropImageToDataUrl(sourceImage, cropRegion);
      } catch (err) {
        console.error("ImageCropModal: crop failed, falling back to source", err);
        outputImage = sourceImage;
      }
    }

    // Close first: the thumbnail encode below is a full-res decode, and making
    // the user watch the modal sit there for it is exactly the kind of stall
    // this whole pass is about. Region and lock go in the same update as the
    // output so downstream consumers never see a half-applied crop.
    closeModal();
    void commitProcessorOutput(updateNodeData, sourceNodeId, outputImage, {
      cropRegion,
      aspectLock,
    });
  }, [sourceNodeId, sourceImage, cropRegion, aspectLock, updateNodeData, closeModal]);

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
    let w = Math.max(5, node.width() * sx);
    let h = Math.max(5, node.height() * sy);
    node.scaleX(1);
    node.scaleY(1);

    // Clamp size to image bounds first (relative to current x/y)
    let x = node.x();
    let y = node.y();
    // Ensure w/h don't extend beyond image
    if (x < 0) { w = w + x; x = 0; }
    if (y < 0) { h = h + y; y = 0; }
    if (x + w > image.width) w = image.width - x;
    if (y + h > image.height) h = image.height - y;
    w = Math.max(5, w);
    h = Math.max(5, h);

    node.width(w);
    node.height(h);
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

          {/* Quick presets */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide mr-1">Preset</span>
            <button
              onClick={handleAdPreset}
              className="px-2.5 py-1 text-xs rounded transition-colors bg-neutral-800 text-neutral-400 hover:text-neutral-200"
              title="AD: source width ÷3 ×2 wide, 16:9 tall, centered"
            >
              AD
            </button>
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
            onWheel={handleWheel}
            draggable={spaceHeld}
            onDragEnd={(e) => setPosition({ x: e.target.x(), y: e.target.y() })}
            style={{ cursor: spaceHeld ? "grab" : "default" }}
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
                  stroke="transparent"
                  strokeWidth={0}
                  fill="transparent"
                  draggable
                  onDragEnd={handleRectDragEnd}
                  onTransform={handleRectTransform}
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
                anchorSize={12}
                anchorFill="#ffffff"
                anchorStroke="#0ea5e9"
                anchorStrokeWidth={2}
                borderStroke="#0ea5e9"
                borderStrokeWidth={1}
                boundBoxFunc={(oldBox, newBox) => {
                  const minSize = 5;
                  // Only reject if completely invalid (below min size)
                  if (newBox.width < minSize || newBox.height < minSize) return oldBox;
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
