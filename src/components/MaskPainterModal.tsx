"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line } from "react-konva";
import { useMaskPainterStore } from "@/store/maskPainterStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { MaskStroke, MaskPainterNodeData } from "@/types";
import Konva from "konva";

/**
 * Full-screen mask painting modal.
 *
 * Users paint black brush strokes on a source image.
 * Output is a white-on-black mask (white = area to inpaint).
 * Only brush and eraser tools, no shapes, no text, no colors.
 */
export function MaskPainterModal() {
  const {
    isModalOpen,
    sourceNodeId,
    sourceImage,
    strokes,
    currentTool,
    brushSize,
    closeModal,
    addStroke,
    clear,
    undo,
    redo,
    setTool,
    setBrushSize,
  } = useMaskPainterStore();

  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const nodes = useWorkflowStore((state) => state.nodes);

  const stageRef = useRef<Konva.Stage>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<MaskStroke | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load source image
  useEffect(() => {
    if (sourceImage) {
      const img = new window.Image();
      img.onload = () => {
        setImage(img);
        if (containerRef.current) {
          const containerWidth = containerRef.current.clientWidth - 100;
          const containerHeight = containerRef.current.clientHeight - 100;
          const scaleX = containerWidth / img.width;
          const scaleY = containerHeight / img.height;
          const newScale = Math.min(scaleX, scaleY, 1);
          setScale(newScale);
          setStageSize({ width: img.width, height: img.height });
          setPosition({
            x: (containerWidth - img.width * newScale) / 2 + 50,
            y: (containerHeight - img.height * newScale) / 2 + 50,
          });
        }
      };
      img.src = sourceImage;
    }
  }, [sourceImage]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === "Escape") {
        closeModal();
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z") {
          e.preventDefault();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
        }
      }
      // B for brush, E for eraser
      if (e.key === "b" || e.key === "B") setTool("brush");
      if (e.key === "e" || e.key === "E") setTool("eraser");
      // [ and ] for brush size
      if (e.key === "[") setBrushSize(Math.max(10, brushSize - 10));
      if (e.key === "]") setBrushSize(Math.min(200, brushSize + 10));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen, brushSize, closeModal, undo, redo, setTool, setBrushSize]);

  const getRelativePointerPosition = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    return transform.point(pos);
  }, []);

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Right-click or middle-click: allow panning
      if (e.evt.button !== 0) return;

      const pos = getRelativePointerPosition();
      setIsDrawing(true);

      const stroke: MaskStroke = {
        id: `stroke-${Date.now()}`,
        points: [pos.x, pos.y],
        strokeWidth: brushSize,
        tool: currentTool,
      };
      setCurrentStroke(stroke);
    },
    [currentTool, brushSize, getRelativePointerPosition]
  );

  const handleMouseMove = useCallback(() => {
    if (!isDrawing || !currentStroke) return;
    const pos = getRelativePointerPosition();
    setCurrentStroke({
      ...currentStroke,
      points: [...currentStroke.points, pos.x, pos.y],
    });
  }, [isDrawing, currentStroke, getRelativePointerPosition]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || !currentStroke) return;
    setIsDrawing(false);

    // Only add if stroke has some length
    if (currentStroke.points.length >= 4) {
      addStroke(currentStroke);
    }
    setCurrentStroke(null);
  }, [isDrawing, currentStroke, addStroke]);

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const scaleBy = 1.1;
      const oldScale = scale;
      const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
      setScale(Math.min(Math.max(newScale, 0.1), 5));
    },
    [scale]
  );

  /**
   * Flatten strokes into a white-on-black mask at source image resolution.
   * Uses a hidden canvas to render strokes:
   * 1. Fill canvas with black (= keep everything)
   * 2. Draw strokes in white (= area to inpaint)
   * 3. Eraser strokes drawn in black (= undo paint)
   */
  const flattenMask = useCallback((): string => {
    if (!image) return "";

    const nodeData = sourceNodeId
      ? (nodes.find((n) => n.id === sourceNodeId)?.data as MaskPainterNodeData)
      : null;
    const blurRadius = nodeData?.blurRadius ?? 0;
    const invertMask = nodeData?.invertMask ?? false;

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    // Start with black background (= keep everything)
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw each stroke
    strokes.forEach((stroke) => {
      ctx.beginPath();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = stroke.strokeWidth;

      if (stroke.tool === "brush") {
        ctx.strokeStyle = "#ffffff"; // White = inpaint area
      } else {
        ctx.strokeStyle = "#000000"; // Eraser = keep area
      }

      if (stroke.points.length >= 2) {
        ctx.moveTo(stroke.points[0], stroke.points[1]);
        for (let i = 2; i < stroke.points.length; i += 2) {
          ctx.lineTo(stroke.points[i], stroke.points[i + 1]);
        }
      }
      ctx.stroke();
    });

    // Apply blur if configured
    if (blurRadius > 0) {
      const blurCanvas = document.createElement("canvas");
      blurCanvas.width = canvas.width;
      blurCanvas.height = canvas.height;
      const blurCtx = blurCanvas.getContext("2d");
      if (blurCtx) {
        blurCtx.filter = `blur(${blurRadius}px)`;
        blurCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(blurCanvas, 0, 0);
      }
    }

    // Invert if configured
    if (invertMask) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];       // R
        data[i + 1] = 255 - data[i + 1]; // G
        data[i + 2] = 255 - data[i + 2]; // B
        // Alpha stays at 255
      }
      ctx.putImageData(imageData, 0, 0);
    }

    return canvas.toDataURL("image/png");
  }, [image, strokes, sourceNodeId, nodes]);

  const handleDone = useCallback(() => {
    if (!sourceNodeId) return;
    const outputMask = flattenMask();
    updateNodeData(sourceNodeId, {
      strokes,
      outputMask,
    });
    closeModal();
  }, [sourceNodeId, strokes, flattenMask, updateNodeData, closeModal]);

  // Render a stroke as a Konva Line
  const renderStroke = (stroke: MaskStroke) => {
    return (
      <Line
        key={stroke.id}
        points={stroke.points}
        stroke={stroke.tool === "brush" ? "#000000" : "#ffffff"}
        strokeWidth={stroke.strokeWidth}
        lineCap="round"
        lineJoin="round"
        opacity={0.6}
        // For eraser, use destination-out composite to reveal background
        globalCompositeOperation={
          stroke.tool === "eraser" ? "destination-out" : "source-over"
        }
      />
    );
  };

  if (!isModalOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      {/* Top Bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5">
          {/* Brush / Eraser toggle */}
          <button
            onClick={() => setTool("brush")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors ${
              currentTool === "brush"
                ? "bg-white text-neutral-900"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Brush
          </button>
          <button
            onClick={() => setTool("eraser")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors ${
              currentTool === "eraser"
                ? "bg-white text-neutral-900"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Eraser
          </button>

          <div className="w-px h-6 bg-neutral-700 mx-3" />

          <button
            onClick={undo}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Undo
          </button>
          <button
            onClick={redo}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Redo
          </button>

          <div className="w-px h-6 bg-neutral-700 mx-3" />

          <button
            onClick={clear}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-red-400"
          >
            Clear
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={closeModal}
            className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleDone}
            className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200"
          >
            Done
          </button>
        </div>
      </div>

      {/* Canvas Container */}
      <div ref={containerRef} className="flex-1 overflow-hidden bg-neutral-900">
        <Stage
          ref={stageRef}
          width={containerRef.current?.clientWidth || 800}
          height={containerRef.current?.clientHeight || 600}
          scaleX={scale}
          scaleY={scale}
          x={position.x}
          y={position.y}
          draggable={false}
          onDragEnd={(e) => {
            if (e.target === stageRef.current)
              setPosition({ x: e.target.x(), y: e.target.y() });
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{ cursor: "crosshair" }}
        >
          <Layer>
            {/* Source image background */}
            {image && (
              <KonvaImage
                image={image}
                width={stageSize.width}
                height={stageSize.height}
              />
            )}
            {/* Painted strokes — drawn in black on the image so user sees what they're masking */}
            {strokes.map(renderStroke)}
            {/* Currently drawing stroke */}
            {currentStroke && renderStroke(currentStroke)}
          </Layer>
        </Stage>
      </div>

      {/* Bottom Options Bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-center gap-6 px-4 border-t border-neutral-800">
        {/* Brush Size Slider */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide">
            Brush Size
          </span>
          <input
            type="range"
            min={10}
            max={200}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-40 accent-white"
          />
          <span className="text-xs text-neutral-400 w-10 text-right">
            {brushSize}px
          </span>
        </div>

        <div className="w-px h-6 bg-neutral-700" />

        {/* Brush preview */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide">
            Preview
          </span>
          <div
            className="rounded-full bg-black border border-neutral-600"
            style={{
              width: Math.min(brushSize * 0.5, 32),
              height: Math.min(brushSize * 0.5, 32),
            }}
          />
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setScale(Math.max(scale - 0.1, 0.1))}
            className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm"
          >
            -
          </button>
          <span className="text-[10px] text-neutral-400 w-10 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale(Math.min(scale + 0.1, 5))}
            className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
