"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { LoadingBadge } from "./LoadingBadge";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import { Image2GSNodeData } from "@/types";
import { useToast } from "@/components/Toast";
import { readCameraJsonFile } from "@/utils/cameraJson";

type Image2GSNodeType = Node<Image2GSNodeData, "image2GS">;

/** Downscale an image data URL to a small JPEG thumbnail for the node preview. */
async function makeImageThumb(dataUrl: string, max = 96): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Image → Gaussian Splat (SHARP) node.
 *
 * RGB (left "image" handle) + an on-node metric-depth EXR → a `.ply` Gaussian
 * splat (right "3d" handle, connect to the Gaussian Splat Viewer). The depth
 * EXR is saved to inputs/ and inspected via the local SHARP backend (channel
 * list + grayscale preview). Generation runs through /api/image2gs.
 */
export function Image2GSNode({ id, data, selected }: NodeProps<Image2GSNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const { isExecuting } = useCanRun(id);

  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingRgb, setIsDraggingRgb] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isLoadingCarousel, setIsLoadingCarousel] = useState(false);

  // ─── Load a saved .ply by id → blob URL (for reload + carousel recall) ──
  const load3DById = useCallback(
    async (modelId: string): Promise<string | null> => {
      // Splats may live in generations/ OR <project>/outputs/GS (routed by the
      // RGB source). Reload from the actual saved folder when we know it.
      const dir = nodeData.savedFilePath
        ? nodeData.savedFilePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "")
        : generationsPath;
      if (!dir) return null;
      try {
        const response = await fetch("/api/load-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directoryPath: dir, imageId: modelId }),
        });
        const result = await response.json();
        if (!result.success) return null;
        const dataUrl: string | undefined = result.model3d || result.image;
        if (!dataUrl) return null;
        // Spark loads from /viewer?url=… — a blob: URL is short + fetchable,
        // unlike a multi-MB data: URL. Mirror the drag-drop .ply path.
        const blob = await (await fetch(dataUrl)).blob();
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    },
    [generationsPath, nodeData.savedFilePath],
  );

  // ─── Re-hydrate output3dUrl from history after a workflow reload ─────────
  const hydrationAttemptedRef = useRef(false);
  useEffect(() => {
    if (hydrationAttemptedRef.current) return;
    // A blob: URL is dead after a reload — re-hydrate from history rather than
    // hand the Splat Viewer a dangling blob. A non-blob (server) URL stays valid.
    if (nodeData.output3dUrl && !nodeData.output3dUrl.startsWith("blob:")) return;
    if (!nodeData.model3dHistory || nodeData.model3dHistory.length === 0) return;
    // savedFilePath (persisted, absolute) is enough — load3DById reads from its
    // folder, so re-hydration works even when the store lost generationsPath on
    // reload (otherwise the stale blob: URL reaches the viewer → Failed to fetch).
    if (!generationsPath && !nodeData.savedFilePath) return;
    hydrationAttemptedRef.current = true;
    const item = nodeData.model3dHistory[nodeData.selectedModel3dHistoryIndex || 0];
    if (item) {
      load3DById(item.id).then((url) => {
        if (url) updateNodeData(id, { output3dUrl: url });
      });
    }
  }, [nodeData.output3dUrl, nodeData.model3dHistory, nodeData.selectedModel3dHistoryIndex, nodeData.savedFilePath, generationsPath, id, load3DById, updateNodeData]);

  // ─── Load camera.json directly (manual) → Focal/Aperture ────────────────
  const handleLoadCameraJson = useCallback(
    async (file: File) => {
      const cj = await readCameraJsonFile(file);
      if (!cj) {
        useToast.getState().show("Invalid camera.json", "error");
        return;
      }
      const patch: Partial<Image2GSNodeData> = { cameraJsonName: cj.name };
      if (cj.focal != null) {
        patch.cameraJsonFocalRaw = cj.focal;
        patch.focalLengthMm = nodeData.focalTwoThirds ? cj.focal * (2 / 3) : cj.focal;
      }
      if (cj.aperture != null) patch.apertureMm = cj.aperture;
      updateNodeData(id, patch);
    },
    [id, nodeData.focalTwoThirds, updateNodeData],
  );
  // The ×2/3 toggle re-applies to the raw camera.json focal (no-op if none loaded).
  const toggleFocalTwoThirds = useCallback(() => {
    const next = !nodeData.focalTwoThirds;
    const patch: Partial<Image2GSNodeData> = { focalTwoThirds: next };
    if (nodeData.cameraJsonFocalRaw != null) {
      patch.focalLengthMm = next ? nodeData.cameraJsonFocalRaw * (2 / 3) : nodeData.cameraJsonFocalRaw;
    }
    updateNodeData(id, patch);
  }, [id, nodeData.focalTwoThirds, nodeData.cameraJsonFocalRaw, updateNodeData]);

  // ─── Run ────────────────────────────────────────────────────────────────
  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // ─── EXR depth: save to inputs/ + inspect channels/preview ──────────────
  const processExrFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".exr")) {
        useToast.getState().show("Please drop a .exr file", "error");
        return;
      }
      if (!saveDirectoryPath) {
        useToast.getState().show("Set a project save directory first", "error");
        return;
      }
      setIsInspecting(true);
      updateNodeData(id, { depthExrFilename: file.name, error: null });
      try {
        // 1) Save the .exr to inputs/ (multipart preserves the .exr extension).
        const stem = file.name.replace(/\.exr$/i, "");
        const saveForm = new FormData();
        saveForm.append("directoryPath", `${saveDirectoryPath}/inputs`);
        saveForm.append("customFilename", stem);
        saveForm.append("createDirectory", "true");
        saveForm.append("file", file);
        const saveRes = await fetch("/api/save-generation", { method: "POST", body: saveForm }).then((r) => r.json());
        if (saveRes.success) {
          updateNodeData(id, { depthExrRef: saveRes.imageId, depthExrPath: saveRes.filePath });
        }

        // 2) Inspect: channel list + grayscale preview (via SHARP backend).
        const inspectForm = new FormData();
        inspectForm.append("depth", file);
        const ins = await fetch("/api/image2gs/inspect", { method: "POST", body: inspectForm }).then((r) => r.json());
        if (ins.success) {
          const channels: string[] = ins.channels || [];
          const def: string | null = ins.defaultChannel || channels[0] || null;
          const keep =
            nodeData.selectedDepthChannel && channels.includes(nodeData.selectedDepthChannel)
              ? nodeData.selectedDepthChannel
              : def;
          updateNodeData(id, {
            depthChannels: channels,
            selectedDepthChannel: keep,
            depthPreviewThumb: ins.preview_png ? `data:image/png;base64,${ins.preview_png}` : null,
            depthWidth: ins.width,
            depthHeight: ins.height,
          });
        } else {
          useToast.getState().show("Couldn't read EXR channels", "error", true, ins.error || "Is the SHARP backend running?");
        }
      } catch (err) {
        useToast.getState().show("EXR load failed", "error", true, err instanceof Error ? err.message : String(err));
      } finally {
        setIsInspecting(false);
      }
    },
    [id, saveDirectoryPath, nodeData.selectedDepthChannel, updateNodeData],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processExrFile(file);
    },
    [processExrFile],
  );
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processExrFile(file);
    },
    [processExrFile],
  );

  const handleRemoveExr = useCallback(() => {
    updateNodeData(id, {
      depthExrRef: undefined,
      depthExrPath: undefined,
      depthExrFilename: undefined,
      depthChannels: [],
      selectedDepthChannel: null,
      depthPreviewThumb: null,
    });
  }, [id, updateNodeData]);

  // ─── RGB image: load exactly like the EXR (save to inputs/ + preview) ────
  const processRgbFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        useToast.getState().show("Please drop an image (PNG/JPG/WebP)", "error");
        return;
      }
      if (!saveDirectoryPath) {
        useToast.getState().show("Set a project save directory first", "error");
        return;
      }
      updateNodeData(id, { rgbSourcePath: file.name });
      try {
        const stem = file.name.replace(/\.[^.]+$/, "");
        const saveForm = new FormData();
        saveForm.append("directoryPath", `${saveDirectoryPath}/inputs`);
        saveForm.append("customFilename", stem);
        saveForm.append("createDirectory", "true");
        saveForm.append("file", file);
        const saveRes = await fetch("/api/save-generation", { method: "POST", body: saveForm }).then((r) => r.json());
        if (saveRes.success) {
          updateNodeData(id, { rgbImageRef: saveRes.imageId, rgbImagePath: saveRes.filePath });
        }
        const dataUrl = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => resolve("");
          r.readAsDataURL(file);
        });
        if (dataUrl) updateNodeData(id, { rgbImageThumb: await makeImageThumb(dataUrl) });
      } catch (err) {
        useToast.getState().show("RGB load failed", "error", true, err instanceof Error ? err.message : String(err));
      }
    },
    [id, saveDirectoryPath, updateNodeData],
  );
  const handleRgbDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingRgb(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processRgbFile(file);
    },
    [processRgbFile],
  );
  const handleRgbDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingRgb(true);
  }, []);
  const handleRgbDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingRgb(false);
  }, []);
  const handleRgbFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processRgbFile(file);
    },
    [processRgbFile],
  );
  const handleRemoveRgb = useCallback(() => {
    updateNodeData(id, {
      rgbImageRef: undefined,
      rgbImagePath: undefined,
      rgbSourcePath: null,
      rgbImageThumb: null,
    });
  }, [id, updateNodeData]);

  const handleClear3D = useCallback(() => {
    updateNodeData(id, {
      output3dUrl: null,
      savedFilename: null,
      savedFilePath: null,
      status: "idle",
      error: null,
    });
  }, [id, updateNodeData]);

  const setNum = useCallback(
    (field: keyof Image2GSNodeData) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value === "" ? null : Number(e.target.value);
      updateNodeData(id, { [field]: v } as Partial<Image2GSNodeData>);
    },
    [id, updateNodeData],
  );

  // ─── Carousel recall ────────────────────────────────────────────────────
  const recall = useCallback(
    async (newIndex: number) => {
      const history = nodeData.model3dHistory || [];
      const item = history[newIndex];
      if (!item) return;
      setIsLoadingCarousel(true);
      const url = await load3DById(item.id);
      setIsLoadingCarousel(false);
      if (url) updateNodeData(id, { output3dUrl: url, selectedModel3dHistoryIndex: newIndex });
    },
    [id, nodeData.model3dHistory, load3DById, updateNodeData],
  );
  const hasCarousel = (nodeData.model3dHistory || []).length > 1;
  const histLen = (nodeData.model3dHistory || []).length;
  const histIdx = nodeData.selectedModel3dHistoryIndex || 0;

  const hasExr = !!nodeData.depthExrRef || !!nodeData.depthExrFilename;
  const hasRgb = !!nodeData.rgbImageRef || !!nodeData.rgbSourcePath;

  return (
    <BaseNode id={id} selected={selected} isExecuting={isExecuting} hasError={nodeData.status === "error"}>
      {/* RGB input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "22%" }}
        data-handletype="image"
        className="!w-3 !h-3 !bg-blue-500 !border-blue-700"
      />
      <div className="absolute text-[10px] font-medium pointer-events-none text-right" style={{ right: "calc(100% + 8px)", top: "calc(22% - 18px)", color: "var(--handle-color-image, #3b82f6)" }}>
        RGB
      </div>

      {/* 3D output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="3d"
        style={{ top: "50%" }}
        data-handletype="3d"
        className="!w-3 !h-3 !bg-emerald-500 !border-emerald-700"
      />
      <div className="absolute text-[10px] font-medium pointer-events-none" style={{ left: "calc(100% + 8px)", top: "calc(50% - 18px)", color: "var(--handle-color-3d, #10b981)" }}>
        3D
      </div>

      <div className="p-3 space-y-2.5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5-9 5 9 5 9-5zM3 7.5v9l9 5 9-5v-9M12 12.5v9" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">Image → Splat</span>
          <span className="text-[9px] text-neutral-500 ml-auto">SHARP</span>
        </div>

        {/* RGB image — loads exactly like the depth EXR below */}
        {!hasRgb ? (
          <div
            onDrop={handleRgbDrop}
            onDragOver={handleRgbDragOver}
            onDragLeave={handleRgbDragLeave}
            className={`rounded-lg border-2 border-dashed transition-colors min-h-[64px] flex flex-col items-center justify-center cursor-pointer ${
              isDraggingRgb ? "border-blue-500 bg-blue-500/10" : "border-neutral-700 hover:border-neutral-600 bg-neutral-900"
            }`}
          >
            <p className="text-[10px] text-neutral-500 text-center px-2">
              Drop <code className="text-blue-400">RGB image</code>
            </p>
            <label className="mt-1 text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer">
              Browse
              <input type="file" accept="image/*" onChange={handleRgbFileSelect} className="hidden" />
            </label>
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-neutral-900 rounded px-2 py-1">
            {nodeData.rgbImageThumb ? (
              <img src={nodeData.rgbImageThumb} alt="rgb" className="w-8 h-8 object-cover rounded shrink-0 border border-neutral-700" draggable={false} />
            ) : (
              <div className="w-8 h-8 rounded shrink-0 bg-neutral-800 flex items-center justify-center">
                <span className="text-[8px] text-neutral-600">IMG</span>
              </div>
            )}
            <span className="text-[10px] text-neutral-300 truncate flex-1" title={nodeData.rgbSourcePath || ""}>
              {nodeData.rgbSourcePath}
            </span>
            <button onClick={handleRemoveRgb} className="nodrag nopan text-neutral-500 hover:text-red-400 shrink-0" title="Remove RGB">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Depth EXR */}
        {!hasExr ? (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`rounded-lg border-2 border-dashed transition-colors min-h-[64px] flex flex-col items-center justify-center cursor-pointer ${
              isDragging ? "border-emerald-500 bg-emerald-500/10" : "border-neutral-700 hover:border-neutral-600 bg-neutral-900"
            }`}
          >
            <p className="text-[10px] text-neutral-500 text-center px-2">
              Drop depth <code className="text-emerald-400">.exr</code>
            </p>
            <label className="mt-1 text-[10px] text-emerald-500 hover:text-emerald-400 cursor-pointer">
              Browse
              <input type="file" accept=".exr" onChange={handleFileSelect} className="hidden" />
            </label>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 bg-neutral-900 rounded px-2 py-1">
              {nodeData.depthPreviewThumb ? (
                <img src={nodeData.depthPreviewThumb} alt="depth" className="w-8 h-8 object-cover rounded shrink-0 border border-neutral-700" draggable={false} />
              ) : (
                <div className="w-8 h-8 rounded shrink-0 bg-neutral-800 flex items-center justify-center">
                  {isInspecting ? (
                    <svg className="w-3.5 h-3.5 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <span className="text-[8px] text-neutral-600">EXR</span>
                  )}
                </div>
              )}
              <span className="text-[10px] text-neutral-300 truncate flex-1" title={nodeData.depthExrFilename || ""}>
                {nodeData.depthExrFilename}
              </span>
              <button onClick={handleRemoveExr} className="nodrag nopan text-neutral-500 hover:text-red-400 shrink-0" title="Remove depth">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Channel selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-neutral-500 shrink-0">Depth ch</span>
              <select
                value={nodeData.selectedDepthChannel || ""}
                onChange={(e) => updateNodeData(id, { selectedDepthChannel: e.target.value || null })}
                className="nodrag nopan flex-1 min-w-0 text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-neutral-200"
              >
                {(nodeData.depthChannels || []).length === 0 && <option value="">{isInspecting ? "scanning…" : "auto"}</option>}
                {(nodeData.depthChannels || []).map((ch) => (
                  <option key={ch} value={ch}>{ch}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Camera intrinsics */}
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] text-neutral-500">Focal (mm)</span>
            <input type="number" step="0.1" value={nodeData.focalLengthMm ?? 24} onChange={setNum("focalLengthMm")} className="nodrag nopan text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-neutral-200" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] text-neutral-500">Aperture (mm)</span>
            <input type="number" step="0.1" value={nodeData.apertureMm ?? 36} onChange={setNum("apertureMm")} className="nodrag nopan text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-neutral-200" />
          </label>
        </div>
        {/* camera.json: load manually → Focal/Aperture; optional ×2/3 on focal */}
        <div className="flex items-center gap-2">
          <label className="nodrag nopan shrink-0 text-[10px] text-emerald-500 hover:text-emerald-400 px-1.5 py-1 border border-neutral-700 rounded hover:border-neutral-600 cursor-pointer">
            Load camera.json
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLoadCameraJson(f);
                e.target.value = "";
              }}
              className="hidden"
            />
          </label>
          <label className="flex items-center gap-1 text-[9px] text-neutral-400 cursor-pointer select-none" title="Multiply the camera.json focal length by 2/3">
            <input type="checkbox" checked={!!nodeData.focalTwoThirds} onChange={toggleFocalTwoThirds} className="nodrag nopan accent-emerald-500" />
            Focal ×⅔
          </label>
        </div>
        {nodeData.cameraJsonName && (
          <p className="text-[8px] text-emerald-600/90 leading-tight truncate" title={`Loaded camera.json · ${nodeData.cameraJsonName}`}>
            ✓ {nodeData.cameraJsonName}
          </p>
        )}

        {/* Blend alpha */}
        <label className="flex items-center gap-2">
          <span className="text-[9px] text-neutral-500 shrink-0 w-[58px]">Blend {Number(nodeData.blendAlpha ?? 0.4).toFixed(2)}</span>
          <input
            type="range" min={0} max={1} step={0.05}
            value={nodeData.blendAlpha ?? 0.4}
            onChange={setNum("blendAlpha")}
            className="nodrag nopan flex-1 accent-emerald-500"
            title="0 = trust depth fully · 1 = ignore depth (vanilla SHARP) · 0.4 = metric anchor"
          />
        </label>

        <p className="text-[8px] text-neutral-600 leading-tight">Depth must be camera-space Z, meters, +Z forward.</p>

        {/* Run */}
        <button
          onClick={handleRun}
          disabled={isExecuting || nodeData.status === "loading"}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium py-1.5 px-3 rounded transition-colors"
        >
          {nodeData.status === "loading" ? "Generating…" : "Generate Splat"}
        </button>

        {/* Output preview */}
        <div className="relative w-full min-h-[80px] flex flex-col items-center justify-center bg-neutral-800 rounded border border-neutral-700 overflow-hidden">
          {nodeData.output3dUrl ? (
            <>
              <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.4}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5-9 5 9 5 9-5zM3 7.5v9l9 5 9-5v-9M12 12.5v9" />
              </svg>
              <span className="text-[9px] text-emerald-300/80 mt-1">.ply ready → Splat Viewer</span>
              {nodeData.savedFilename && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!nodeData.savedFilePath) return;
                    try {
                      await fetch("/api/open-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath: nodeData.savedFilePath }) });
                    } catch { /* ignore */ }
                  }}
                  className="nodrag nopan text-[9px] text-neutral-400 hover:text-emerald-300 truncate max-w-full px-2 mt-0.5"
                  title={`Open: ${nodeData.savedFilePath}`}
                >
                  {nodeData.savedFilename}
                </button>
              )}
              <button onClick={handleClear3D} className="nodrag nopan absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white" title="Clear splat">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {hasCarousel && (
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-1 bg-neutral-900/60">
                  <button onClick={(e) => { e.stopPropagation(); recall(histIdx === 0 ? histLen - 1 : histIdx - 1); }} disabled={isLoadingCarousel} className="nodrag nopan w-4 h-4 text-white/70 hover:text-white disabled:opacity-40">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                  </button>
                  <span className="text-[9px] text-white/70">{histIdx + 1} / {histLen}</span>
                  <button onClick={(e) => { e.stopPropagation(); recall((histIdx + 1) % histLen); }} disabled={isLoadingCarousel} className="nodrag nopan w-4 h-4 text-white/70 hover:text-white disabled:opacity-40">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                  </button>
                </div>
              )}
            </>
          ) : nodeData.status === "loading" ? (
            <div className="flex flex-col items-center gap-1">
              <LoadingBadge active loadingStartedAt={nodeData.loadingStartedAt} loadingPhase={nodeData.loadingPhase} queuePosition={nodeData.queuePosition} />
              <svg className="w-5 h-5 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : nodeData.status === "error" ? (
            <span className="text-[10px] text-red-400 text-center px-2">{nodeData.error || "Failed"}</span>
          ) : (
            <span className="text-neutral-500 text-[10px]">Generate to create splat</span>
          )}
        </div>
      </div>
    </BaseNode>
  );
}
