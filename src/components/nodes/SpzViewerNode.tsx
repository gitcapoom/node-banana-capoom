"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import { SpzViewerNodeData } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { saveMediaImmediately } from "@/utils/mediaStorage";
import { readCameraJsonFile } from "@/utils/cameraJson";

type SpzViewerNodeType = Node<SpzViewerNodeData, "spzViewer">;

/** Accepted file extensions */
const ACCEPTED_EXTENSIONS = [".spz", ".ply"];

/**
 * SPZ Viewer node.
 *
 * Lightweight node that opens the external standalone 3D viewer window.
 * Accepts SPZ/PLY URLs from upstream nodes (via "3d" handle) or
 * drag-and-drop of local .spz/.ply files.
 * Captures screenshots from the viewer via postMessage.
 *
 * Input: 3d (left)
 * Output: image (right) — captured screenshots
 */
export function SpzViewerNode({ id, data, selected }: NodeProps<SpzViewerNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const nodes = useWorkflowStore((state) => state.nodes);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const edges = useWorkflowStore((state) => state.edges);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const { isExecuting } = useCanRun(id);

  const viewerWindowRef = useRef<Window | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);

  // ─── Viewer window postMessage listener ─────────────────────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      // Handle splat-viewer-state messages (viewer state sync)
      if (event.data?.type === "splat-viewer-state" && event.data.worldId === id) {
        updateNodeData(id, { viewerState: event.data.state });
        try {
          sessionStorage.setItem(`splat-viewer-state-${id}`, JSON.stringify(event.data.state));
        } catch (_) { /* quota */ }
        return;
      }

      if (event.data?.type !== "worldlabs-capture") return;
      // Use node ID as worldId for routing
      if (event.data.worldId !== id) return;

      const { image, depthImage, filename, width, height } = event.data;

      // Create ImageInput nodes to the right with the capture
      const currentNode = nodes.find((n) => n.id === id);
      const nodeX = currentNode?.position?.x ?? 0;
      const nodeY = currentNode?.position?.y ?? 0;
      const nodeDims = defaultNodeDimensions.spzViewer;
      const imgNodeHeight = defaultNodeDimensions.imageInput.height;

      const offsetX = nodeDims.width + 40;
      // Each capture creates 1 or 2 nodes (RGB + optional depth)
      const nodesPerCapture = depthImage ? 2 : 1;
      const baseOffsetY = captureCount * nodesPerCapture * (imgNodeHeight + 20);

      // RGB image node
      addNode("imageInput", {
        x: nodeX + offsetX,
        y: nodeY + baseOffsetY,
      });

      // Save captures to inputs folder and update the new nodes
      const saveAndUpdate = async () => {
        const latestNodes = useWorkflowStore.getState().nodes;
        const newNode = latestNodes[latestNodes.length - 1];

        // Save RGB image to inputs folder
        let imageRef: string | undefined;
        if (saveDirectoryPath && image) {
          const refId = await saveMediaImmediately(image, saveDirectoryPath, "inputs");
          if (refId) imageRef = refId;
        }

        if (newNode && newNode.type === "imageInput") {
          updateNodeData(newNode.id, {
            image,
            imageRef,
            filename: `${filename}.png`,
            dimensions: width && height ? { width, height } : null,
          });
        }

        // Depth image node (if depth was captured)
        if (depthImage) {
          addNode("imageInput", {
            x: nodeX + offsetX,
            y: nodeY + baseOffsetY + imgNodeHeight + 20,
          });

          setTimeout(async () => {
            const depthNodes = useWorkflowStore.getState().nodes;
            const depthNode = depthNodes[depthNodes.length - 1];

            let depthRef: string | undefined;
            if (saveDirectoryPath && depthImage) {
              const refId = await saveMediaImmediately(depthImage, saveDirectoryPath, "inputs");
              if (refId) depthRef = refId;
            }

            if (depthNode && depthNode.type === "imageInput") {
              updateNodeData(depthNode.id, {
                image: depthImage,
                imageRef: depthRef,
                filename: `${filename}_depth.png`,
                dimensions: width && height ? { width, height } : null,
              });
            }
          }, 50);
        }
      };

      setTimeout(saveAndUpdate, 50);

      setCaptureCount((c) => c + 1);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [id, nodes, addNode, updateNodeData, captureCount]);

  // ─── Check if viewer window is still open ───────────────────
  useEffect(() => {
    if (!nodeData.viewerOpen) return;

    const interval = setInterval(() => {
      if (viewerWindowRef.current?.closed) {
        viewerWindowRef.current = null;
        updateNodeData(id, { viewerOpen: false });
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [id, nodeData.viewerOpen, updateNodeData]);

  // ─── Blob URL cleanup on unmount ────────────────────────────
  const blobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    // Track blob URLs for cleanup
    if (nodeData.spzUrl?.startsWith("blob:")) {
      blobUrlRef.current = nodeData.spzUrl;
    }
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [nodeData.spzUrl]);

  // ─── Auto-adopt a connected 3D input ────────────────────────
  // This node has no Run button, so without this, wiring an upstream splat
  // (e.g. Image → Splat) wouldn't load until the upstream re-ran. Adopt the
  // connected model3d as soon as it appears or changes (connect, or upstream
  // regeneration). Connected input takes precedence over a drag-dropped file.
  useEffect(() => {
    const { model3d } = getConnectedInputs(id);
    if (model3d && model3d !== nodeData.spzUrl) {
      updateNodeData(id, {
        spzUrl: model3d,
        filename: nodeData.filename || "splat.ply",
        capturedImage: null,
        capturedDepthImage: null,
      });
    }
  }, [edges, nodes, id, getConnectedInputs, nodeData.spzUrl, nodeData.filename, updateNodeData]);

  // ─── Re-hydrate a drag-dropped splat after a workflow reload ─
  // blob: URLs die with the page, so a reopened workflow carries a dead
  // spzUrl. The drop handler persisted the file under <project>/inputs
  // (splatFileId) — mint a fresh blob URL from it. One-shot; skipped when a
  // 3d input is connected (the upstream re-hydrates itself and the auto-adopt
  // effect above takes precedence) or when spzUrl is a still-valid http URL.
  const splatHydrationRef = useRef(false);
  useEffect(() => {
    if (splatHydrationRef.current) return;
    if (!nodeData.splatFileId || !saveDirectoryPath) return;
    if (nodeData.spzUrl && !nodeData.spzUrl.startsWith("blob:")) return;
    const has3dInput = edges.some(
      (e) => e.target === id && (e.targetHandle ?? "").startsWith("3d"),
    );
    if (has3dInput) {
      splatHydrationRef.current = true;
      return;
    }
    splatHydrationRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/load-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: `${saveDirectoryPath}/inputs`,
            imageId: nodeData.splatFileId,
          }),
        });
        const result = await res.json();
        const dataUrl: string | undefined = result.model3d || result.image;
        if (!result.success || !dataUrl) return;
        // Same as the drop path: Spark fetches /viewer?url=… — a blob: URL is
        // short and fetchable, unlike a multi-MB data: URL.
        const blob = await (await fetch(dataUrl)).blob();
        updateNodeData(id, { spzUrl: URL.createObjectURL(blob) });
      } catch (e) {
        console.warn("[SpzViewer] Failed to re-hydrate dropped splat:", e);
      }
    })();
  }, [id, edges, nodeData.splatFileId, nodeData.spzUrl, saveDirectoryPath, updateNodeData]);

  // ─── Handlers ──────────────────────────────────────────────

  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleOpenViewer = useCallback(() => {
    // Works with OR without a splat — opening empty lets the user load a saved
    // scene (sidecar JSON) from inside the viewer.
    const params = new URLSearchParams({
      name: nodeData.filename || "Gaussian Splat Viewer",
      worldId: id, // Use node ID for postMessage routing
    });
    if (nodeData.spzUrl) params.set("url", nodeData.spzUrl);

    // Default "Save Scene" target: <project>/outputs/GS, using the project
    // path's own separator (it may be a UNC/network path with backslashes).
    if (saveDirectoryPath) {
      const base = saveDirectoryPath.replace(/[\\/]+$/, "");
      const sep = base.includes("\\") ? "\\" : "/";
      params.set("gsDir", `${base}${sep}outputs${sep}GS`);
      // Project folder — the viewer derives camera.json / 3D_Renders defaults one
      // level up from here (next to the project folder).
      params.set("projectDir", base);
    }

    // image2GS outputs a .ply. Its filename can default to "world.spz", which
    // makes the viewer treat it as SPZ and SKIP the PLY orientation (→ 180°-X
    // off). When the source is image2GS, force a .ply name so the viewer applies
    // the PLY world rotation.
    if (nodeData.spzUrl) {
      const { edges, nodes } = useWorkflowStore.getState();
      const inEdge = edges.find(
        (e) => e.target === id && (e.targetHandle === "3d" || (e.targetHandle ?? "").startsWith("3d")),
      );
      const src = inEdge ? nodes.find((n) => n.id === inEdge.source) : undefined;
      if (src?.type === "image2GS") {
        params.set("name", "splat.ply");
      }
    }

    // Lens/Sensor come from a camera.json loaded directly on THIS node.
    if (typeof nodeData.cameraJsonFocal === "number") params.set("lens", String(nodeData.cameraJsonFocal));
    if (typeof nodeData.cameraJsonAperture === "number") params.set("sensor", String(nodeData.cameraJsonAperture));

    // Cache-buster: /viewer proxies the hosted build's index.html, which is
    // served without Cache-Control — force a fresh copy so redeployed viewer
    // builds show up on next open (same pattern as the render-tracking viewer).
    params.set("_cb", String(Date.now()));

    // Persist viewer state to sessionStorage so the viewer can restore it on open
    if (nodeData.viewerState) {
      try {
        sessionStorage.setItem(`splat-viewer-state-${id}`, JSON.stringify(nodeData.viewerState));
      } catch (_) { /* quota */ }
    }

    const viewerUrl = `/viewer?${params.toString()}`;
    const w = window.open(viewerUrl, `spz-viewer-${id}`, "width=1280,height=720,alwaysOnTop=yes");
    viewerWindowRef.current = w;
    updateNodeData(id, { viewerOpen: true });
  }, [id, nodeData.spzUrl, nodeData.filename, nodeData.cameraJsonFocal, nodeData.cameraJsonAperture, nodeData.viewerState, saveDirectoryPath, updateNodeData]);

  const handleLoadCameraJson = useCallback(
    async (file: File) => {
      const cj = await readCameraJsonFile(file);
      if (!cj) return;
      updateNodeData(id, {
        cameraJsonName: cj.name,
        cameraJsonFocal: cj.focal,
        cameraJsonAperture: cj.aperture,
      });
    },
    [id, updateNodeData],
  );

  const isAcceptedFile = useCallback((filename: string) => {
    const lower = filename.toLowerCase();
    return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }, []);

  // Persist a dropped splat under <project>/inputs so it survives a workflow
  // reload (the blob: URL below dies with the page). Fire-and-forget — the
  // blob URL is usable immediately; splatFileId lands when the save completes.
  const persistDroppedSplat = useCallback(
    async (file: File) => {
      if (!saveDirectoryPath) return;
      try {
        const ext = file.name.toLowerCase().endsWith(".spz") ? "spz" : "ply";
        const rawDataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        // FileReader reports application/octet-stream — rewrite the mime so
        // save-generation keeps the .ply/.spz extension (the viewer keys PLY
        // world-orientation off the filename).
        const dataUrl = rawDataUrl.replace(/^data:[^;]*;base64,/, `data:model/${ext};base64,`);
        const res = await fetch("/api/save-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: `${saveDirectoryPath}/inputs`,
            model3d: dataUrl,
            createDirectory: true,
          }),
        });
        const result = await res.json();
        if (result.imageId) updateNodeData(id, { splatFileId: result.imageId });
      } catch (e) {
        console.warn("[SpzViewer] Failed to persist dropped splat:", e);
      }
    },
    [id, saveDirectoryPath, updateNodeData],
  );

  const processFile = useCallback(
    (file: File) => {
      if (!isAcceptedFile(file.name)) {
        return;
      }

      // Revoke previous blob URL
      if (nodeData.spzUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(nodeData.spzUrl);
      }

      // A fresh drop supersedes any pending reload-hydration this mount.
      splatHydrationRef.current = true;

      const url = URL.createObjectURL(file);
      updateNodeData(id, {
        spzUrl: url,
        filename: file.name,
        splatFileId: null, // stale id must not rehydrate the previous splat
        capturedImage: null,
        capturedDepthImage: null,
      });
      void persistDroppedSplat(file);
    },
    [id, nodeData.spzUrl, updateNodeData, isAcceptedFile, persistDroppedSplat]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
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
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleRemove = useCallback(() => {
    if (nodeData.spzUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(nodeData.spzUrl);
    }
    // Close viewer window if open
    if (viewerWindowRef.current && !viewerWindowRef.current.closed) {
      viewerWindowRef.current.close();
    }
    updateNodeData(id, {
      spzUrl: null,
      filename: null,
      capturedImage: null,
      capturedDepthImage: null,
      viewerOpen: false,
    });
  }, [id, nodeData.spzUrl, updateNodeData]);

  // ─── Render ─────────────────────────────────────────────────

  const hasFile = !!nodeData.spzUrl;

  return (
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isExecuting}
    >
      {/* Input Handle — 3D data */}
      <Handle
        type="target"
        position={Position.Left}
        id="3d"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-emerald-500 !border-emerald-700"
      />

      {/* Output Handle — captured image */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-violet-500 !border-violet-700"
      />

      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="text-xs font-medium text-neutral-300">Gaussian Splat Viewer</span>
          {nodeData.viewerOpen && (
            <span className="text-[9px] text-emerald-400 ml-auto flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Viewer open
            </span>
          )}
        </div>

        {/* Drop Zone / File Info */}
        {!hasFile ? (
          <>
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`rounded-lg border-2 border-dashed transition-colors min-h-[80px] flex flex-col items-center justify-center cursor-pointer ${
              isDragging
                ? "border-emerald-500 bg-emerald-500/10"
                : "border-neutral-700 hover:border-neutral-600 bg-neutral-900"
            }`}
          >
            <svg
              className="w-8 h-8 text-neutral-600 mb-1"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <p className="text-[10px] text-neutral-500 text-center px-2">
              Drop <code className="text-emerald-400">.spz</code> or{" "}
              <code className="text-emerald-400">.ply</code> file
              <br />
              or connect 3D input
            </p>
            <label className="mt-2 text-[10px] text-emerald-500 hover:text-emerald-400 cursor-pointer transition-colors">
              Browse
              <input
                type="file"
                accept=".spz,.ply"
                onChange={handleFileSelect}
                className="hidden"
              />
            </label>
          </div>
          {/* Open the viewer with no splat, to load a previously saved scene */}
          <button
            onClick={handleOpenViewer}
            className="mt-2 w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[11px] font-medium py-1.5 px-3 rounded transition-colors"
            title="Open the viewer empty, then load a saved scene (.json) from inside it"
          >
            Open empty viewer — load saved scene
          </button>
          </>
        ) : (
          <div className="space-y-2">
            {/* File info */}
            <div className="flex items-center gap-2 bg-neutral-900 rounded-lg px-2 py-1.5">
              <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-xs text-neutral-300 truncate flex-1">
                {nodeData.filename}
              </span>
              <button
                onClick={handleRemove}
                className="text-neutral-500 hover:text-red-400 transition-colors shrink-0"
                title="Remove file"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Open Viewer button */}
            <button
              onClick={handleOpenViewer}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium py-1.5 px-3 rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {nodeData.viewerOpen ? "Focus Viewer" : "Open Viewer"}
            </button>

            {/* Drag-and-drop overlay for replacing file */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className="w-full"
            >
              {isDragging && (
                <div className="rounded-lg border-2 border-dashed border-emerald-500 bg-emerald-500/10 py-2 text-center">
                  <p className="text-[10px] text-emerald-400">Drop to replace</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* camera.json → viewer Lens/Sensor */}
        <div className="flex items-center gap-2 pt-1">
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
          {nodeData.cameraJsonName && (
            <span className="text-[9px] text-emerald-600/90 truncate" title={`Lens/Sensor from camera.json · ${nodeData.cameraJsonName}`}>
              ✓ {nodeData.cameraJsonName}
            </span>
          )}
        </div>

        {/* Handle labels */}
        <div className="absolute left-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          3d
        </div>
        <div className="absolute right-5 text-[9px] text-neutral-600" style={{ top: "50%", transform: "translateY(-50%)" }}>
          image
        </div>
      </div>
    </BaseNode>
  );
}
