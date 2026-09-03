"use client";

import { ReactNode, useCallback, useMemo, useRef, useLayoutEffect } from "react";
import { Node, NodeResizer, OnResize, useReactFlow, useNodesData } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useNodeMediaViewer } from "@/store/nodeMediaViewerStore";
import { isPanningRef } from "@/components/WorkflowCanvas";
import { getMediaDimensions, calculateAspectFitSize } from "@/utils/nodeDimensions";
import { MediaResolutionBadge } from "./MediaResolutionBadge";
import { useThumbnailPending } from "@/lib/thumbnailSize";
import type { MediaType } from "@/components/MediaOverlay";
import { isCancellableNodeType } from "@/lib/cancellableNodes";

const DEFAULT_NODE_DIMENSION = 300;

interface BaseNodeProps {
  id: string;
  children: ReactNode;
  selected?: boolean;
  isExecuting?: boolean;
  hasError?: boolean;
  className?: string;
  contentClassName?: string;
  minWidth?: number;
  minHeight?: number;
  /** When true, node has no background/border — content fills the entire node area */
  fullBleed?: boolean;
  /** Media URL (image/video) to use for aspect-fit resize on resize-handle double-click */
  aspectFitMedia?: string | null;
  /** When true, bottom corners lose rounding so the selection ring connects to the settings panel below */
  settingsExpanded?: boolean;
  /** Settings panel rendered outside the bordered area so it shares the node's full width */
  settingsPanel?: ReactNode;
}

/**
 * Read a node's effective width or height, respecting React Flow's internal
 * priority: node.width > node.style.width > node.measured.width.
 */
function getNodeDimension(node: Node, axis: "width" | "height"): number {
  return (
    (node[axis] as number) ??
    (node.style?.[axis] as number) ??
    (node.measured?.[axis] as number) ??
    DEFAULT_NODE_DIMENSION
  );
}

/**
 * Apply dimensions to a React Flow node, writing to both `node.width/height`
 * (where NodeResizer writes) and `node.style` (the original source) so neither
 * silently overrides the other.
 */
function applyNodeDimensions(node: Node, width: number, height: number): Node {
  return {
    ...node,
    width,
    height,
    style: { ...node.style, width, height },
  };
}

export function BaseNode({
  id,
  children,
  selected = false,
  isExecuting = false,
  hasError = false,
  className = "",
  contentClassName,
  minWidth = 180,
  minHeight = 100,
  fullBleed = false,
  aspectFitMedia,
  settingsExpanded = false,
  settingsPanel,
}: BaseNodeProps) {
  const currentNodeIds = useWorkflowStore((state) => state.currentNodeIds);
  const setHoveredNodeId = useWorkflowStore((state) => state.setHoveredNodeId);
  const cancelNode = useWorkflowStore((state) => state.cancelNode);
  const isCurrentlyExecuting = currentNodeIds.includes(id);
  const { getNodes, setNodes } = useReactFlow();

  // Resolution-badge inputs, read through React Flow's own id→node index.
  //
  // This is deliberately NOT a useWorkflowStore selector: BaseNode wraps EVERY
  // node, zustand re-runs every subscriber's selector on every store write, and
  // a `nodes.find()` inside one makes each write cost O(nodes²). With a graph
  // full of GPU nodes — which write on each commit — that alone made panning
  // crawl. `useNodesData` is an indexed lookup with a shallow compare.
  const thumbRendering = useThumbnailPending(id);
  const nodeData = useNodesData(id);
  const { storedDims, mediaIsThumb } = useMemo(() => {
    const data = nodeData?.data as Record<string, unknown> | undefined;
    if (!data) return { storedDims: null, mediaIsThumb: false };
    return {
      // Source dimensions persisted next to the thumbnail at save time, under
      // `<field>Dims`; `aspectFitMedia` carries no field name, so we check the
      // conventional display fields.
      storedDims: (data.outputImageDims ??
        data.outputMaskDims ??
        data.imageDims ??
        data.sourceImageDims ??
        null) as { width: number; height: number } | null,
      // Nodes render `fullRes ?? thumb`, so this is an identity check rather
      // than a guess — it keeps the badge from reporting a thumbnail's own size.
      mediaIsThumb: !!aspectFitMedia &&
        (aspectFitMedia === data.outputImageThumb ||
          aspectFitMedia === data.imageThumb ||
          aspectFitMedia === data.sourceImageThumb ||
          aspectFitMedia === data.outputMaskThumb),
    };
  }, [nodeData, aspectFitMedia]);

  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackedSettingsHeightRef = useRef(0);
  const isAnimatingRef = useRef(false);
  const animationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adjust node height when settings expand or collapse
  useLayoutEffect(() => {
    // Cancel any pending animation timeout from a previous toggle (handles rapid toggling)
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
      animationTimeoutRef.current = null;
    }

    const contentEl = contentRef.current;
    const ANIMATION_MS = 160;

    if (!settingsExpanded && trackedSettingsHeightRef.current > 0) {
      // --- COLLAPSE ---
      const heightToRemove = trackedSettingsHeightRef.current;
      trackedSettingsHeightRef.current = 0;
      isAnimatingRef.current = true;

      // Lock content height for the full animation duration
      if (contentEl) {
        contentEl.style.height = contentEl.offsetHeight + "px";
      }

      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id !== id) return node;
          const currentHeight = getNodeDimension(node, "height");
          const newHeight = Math.max(minHeight, currentHeight - heightToRemove);
          return applyNodeDimensions(node, getNodeDimension(node, "width"), newHeight);
        })
      );

      animationTimeoutRef.current = setTimeout(() => {
        isAnimatingRef.current = false;
        if (contentEl) contentEl.style.height = "";
      }, ANIMATION_MS);
    } else if (settingsExpanded && settingsPanel) {
      // --- EXPAND ---
      // Lock the content wrapper rigid so flex can't redistribute space as the
      // settings panel grows. Without this, flex-1 + min-h-0 lets the wrapper
      // shrink between CSS transition frames and the ResizeObserver setNodes catch-up.
      isAnimatingRef.current = true;

      if (contentEl) {
        const wrapperEl = contentEl.parentElement as HTMLElement | null;
        if (wrapperEl) {
          wrapperEl.style.flex = "none";
          wrapperEl.style.height = wrapperEl.offsetHeight + "px";
        }
      }

      animationTimeoutRef.current = setTimeout(() => {
        isAnimatingRef.current = false;

        // Apply the final panel height in one shot, then unlock the wrapper
        const finalHeight = trackedSettingsHeightRef.current;
        if (finalHeight > 0) {
          setNodes((nodes) =>
            nodes.map((node) => {
              if (node.id !== id) return node;
              const currentHeight = getNodeDimension(node, "height");
              return applyNodeDimensions(node, getNodeDimension(node, "width"), currentHeight + finalHeight);
            })
          );
        }

        if (contentEl) {
          const wrapperEl = contentEl.parentElement as HTMLElement | null;
          if (wrapperEl) {
            wrapperEl.style.flex = "";
            wrapperEl.style.height = "";
          }
        }
      }, ANIMATION_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsExpanded]);

  // ResizeObserver to track dynamic settings panel height changes (e.g., model param count changes)
  useLayoutEffect(() => {
    if (!settingsExpanded || !settingsPanel) return;
    const panelEl = settingsPanelRef.current;
    if (!panelEl) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newPanelHeight = entry.contentRect.height;
        if (newPanelHeight === 0) continue;
        const delta = newPanelHeight - trackedSettingsHeightRef.current;
        if (Math.abs(delta) < 2) continue; // Ignore sub-pixel changes

        trackedSettingsHeightRef.current = newPanelHeight;

        // During animation, just track the height — skip setNodes to avoid
        // multiple re-renders. The expand timeout will apply one final update.
        if (isAnimatingRef.current) continue;

        // Lock content height to prevent image flicker during resize
        const contentEl = contentRef.current;
        if (contentEl) {
          contentEl.style.height = contentEl.offsetHeight + "px";
        }

        setNodes((nodes) =>
          nodes.map((node) => {
            if (node.id !== id) return node;
            const currentHeight = getNodeDimension(node, "height");
            const newHeight = Math.max(minHeight, currentHeight + delta);
            return applyNodeDimensions(node, getNodeDimension(node, "width"), newHeight);
          })
        );

        // Release locked height after layout settles
        requestAnimationFrame(() => {
          if (contentEl) {
            contentEl.style.height = "";
          }
        });
      }
    });

    observer.observe(panelEl);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsExpanded, settingsPanel]);

  // Cleanup animation timeout on unmount
  useLayoutEffect(() => {
    return () => {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
    };
  }, []);

  const handleResize: OnResize = useCallback(
    (_event, params) => {
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.selected && node.id !== id) {
            return applyNodeDimensions(node, params.width, params.height);
          }
          return node;
        })
      );
    },
    [id, setNodes]
  );

  const openMediaViewer = useNodeMediaViewer((s) => s.open);

  const handleNodeDblClick = useCallback(
    async (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;

      // A node's preview opts into the shared full-screen viewer by marking its
      // media element `data-node-media="<field>"`. Nodes that own a richer
      // editor (annotation, crop, comp, the GPU editors) handle their own
      // double-click instead and simply don't carry the marker.
      const media = target.closest<HTMLElement>("[data-node-media]");
      if (media && !e.defaultPrevented) {
        const field = media.dataset.nodeMedia;
        if (field) {
          e.stopPropagation();
          openMediaViewer({
            nodeId: id,
            field,
            mediaType: (media.dataset.nodeMediaType as MediaType) || "image",
            folder: media.dataset.nodeMediaFolder === "generations" ? "generations" : "inputs",
          });
          return;
        }
      }

      if (!target.closest(".react-flow__resize-control")) return;
      if (!aspectFitMedia) return;

      e.stopPropagation();
      const dims = await getMediaDimensions(aspectFitMedia);
      if (!dims) return;

      const thisNode = getNodes().find((n) => n.id === id);
      if (!thisNode) return;

      const nodeHeight = getNodeDimension(thisNode, "height");
      const contentHeight = nodeHeight - trackedSettingsHeightRef.current;

      const newSize = calculateAspectFitSize(
        dims.width / dims.height,
        getNodeDimension(thisNode, "width"),
        contentHeight,
        fullBleed
      );

      const finalHeight = newSize.height + trackedSettingsHeightRef.current;

      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === id || (n.selected && n.id !== id)) {
            return applyNodeDimensions(n, newSize.width, finalHeight);
          }
          return n;
        })
      );
    },
    [aspectFitMedia, id, fullBleed, getNodes, setNodes, openMediaViewer]
  );

  const hasExpandedSettings = settingsExpanded && settingsPanel;

  return (
    <div
      className={hasExpandedSettings
        ? `relative flex flex-col w-full h-full overflow-visible bg-neutral-800 rounded-lg ${selected ? "ring-2 ring-blue-500/40 shadow-lg shadow-blue-500/25" : ""}`
        : "contents"}
      onDoubleClick={handleNodeDblClick}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={minWidth}
        minHeight={minHeight}
        lineClassName="!border-transparent"
        handleClassName="!w-5 !h-5 !bg-transparent !border-none"
        onResize={handleResize}
      />
      <div
        className={`
          ${hasExpandedSettings ? "flex-1 min-h-0 w-full" : "h-full w-full"} flex flex-col overflow-visible relative
          ${fullBleed
            ? `${settingsExpanded ? "rounded-t-lg border-b-0" : "rounded-lg"} bg-neutral-800/50 border border-neutral-700/40`
            : `bg-neutral-800 ${settingsExpanded ? "rounded-t-lg border-b-0" : "rounded-lg"} shadow-lg border`}
          ${fullBleed ? "" : (isCurrentlyExecuting || isExecuting ? "border-blue-500 ring-1 ring-blue-500/20" : "border-neutral-700/60")}
          ${fullBleed ? "" : (hasError ? "border-red-500" : "")}
          ${fullBleed && selected && !settingsExpanded ? "ring-2 ring-blue-500/40 shadow-lg shadow-blue-500/25" : ""}
          ${!fullBleed && selected && !settingsExpanded ? "border-blue-500 ring-2 ring-blue-500/40 shadow-lg shadow-blue-500/25" : ""}
          ${!fullBleed && selected && settingsExpanded ? "border-blue-500" : ""}
          ${className}
        `}
        onMouseEnter={() => {
          if (isPanningRef.current) return;
          setHoveredNodeId(id);
        }}
        onMouseLeave={() => {
          if (isPanningRef.current) return;
          setHoveredNodeId(null);
        }}
      >
        <div ref={contentRef} className={contentClassName ?? (fullBleed ? "flex-1 min-h-0 relative" : "px-3 pb-4 flex-1 min-h-0 overflow-hidden flex flex-col")}>{children}</div>
        {/* Cancel — only while THIS node is actually in flight, and only for
            node types that hand work to a remote API. `currentNodeIds` is the
            reactive source of truth; the controller map is mutated in place and
            deliberately does not trigger re-renders. */}
        {(isCurrentlyExecuting || isExecuting) && isCancellableNodeType(nodeData?.type) && (
          <button
            type="button"
            className="nodrag nopan absolute top-1.5 right-1.5 z-20 rounded px-2 py-0.5 text-[10px] font-medium
                       bg-neutral-900/85 text-neutral-200 border border-neutral-600
                       hover:bg-red-600 hover:border-red-500 hover:text-white transition-colors"
            title="Cancel this generation"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              cancelNode(id);
            }}
          >
            Cancel
          </button>
        )}
        {/* Resolution readout — every node that shows media gets one, since
            aspectFitMedia is already the node's displayed image/video. */}
        <MediaResolutionBadge
          media={aspectFitMedia}
          storedDims={storedDims}
          mediaIsThumb={mediaIsThumb}
          rendering={thumbRendering}
        />
      </div>
      {settingsPanel && (
        <div ref={settingsPanelRef}>
          {settingsPanel}
        </div>
      )}
    </div>
  );
}
