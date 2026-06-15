/**
 * image2GS Executor
 *
 * Runs the local SHARP backend (via /api/image2gs) to turn a connected RGB
 * image + an on-node metric-depth EXR into a 3D Gaussian Splat `.ply`.
 *
 * Output mirrors generate3d: a short-lived blob: URL on `output3dUrl` (consumed
 * by the Gaussian Splat Viewer, which opens /viewer?url=…) plus an auto-save of
 * the `.ply` into the generations folder for persistence across reloads.
 *
 * The metric float depth never travels a graph edge — it is loaded straight
 * from the saved `.exr` and forwarded to the backend, which reads it with the
 * SHARP module's `load_depth_exr`.
 */

import type { Image2GSNodeData, Carousel3DItem } from "@/types";
import { loadMediaById } from "@/utils/mediaStorage";
import { driveToUnc, filenameStem } from "@/utils/pathTranslation";
import type { NodeExecutionContext } from "./types";

/** Convert a data: URL (or any fetchable URL) into a Blob (browser context). */
async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return await res.blob();
}

export async function executeImage2GS(ctx: NodeExecutionContext): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    getNodes,
    getEdges,
    signal,
    generationsPath,
    saveDirectoryPath,
    trackSaveGeneration,
  } = ctx;

  const { images } = getConnectedInputs(node.id);
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as Image2GSNodeData;

  // Recover the project dir from the saved EXR path when the store lost
  // saveDirectoryPath (a page reload restores the workflow but not the project
  // dir). depthExrPath = <saveDir>/inputs/<file>.exr.
  const effectiveSaveDir =
    saveDirectoryPath ||
    (nodeData.depthExrPath
      ? nodeData.depthExrPath.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\/inputs\/[^/]*$/i, "")
      : null);
  const effectiveGenerationsPath =
    generationsPath || (effectiveSaveDir ? `${effectiveSaveDir}/generations` : null);

  let rgb = images[0] || nodeData.inputImages?.[0] || null;
  // RGB loaded directly on the node (mirrors the EXR load) — read it from inputs/.
  if (!rgb && nodeData.rgbImageRef && effectiveSaveDir) {
    rgb = await loadMediaById(nodeData.rgbImageRef, effectiveSaveDir, "inputs");
  }
  // The upstream image's full-res may be unloaded — the lazy full-res pre-pass
  // no-ops when saveDirectoryPath is null. Pull the RGB straight from the
  // connected source node's data (raw value, else its saved ref).
  if (!rgb && effectiveSaveDir) {
    const inEdge = getEdges().find(
      (e) => e.target === node.id && (e.targetHandle === "image" || (e.targetHandle ?? "").startsWith("image")),
    );
    const src = inEdge ? getNodes().find((n) => n.id === inEdge.source) : undefined;
    const sd = src?.data as
      | { image?: string | null; outputImage?: string | null; imageRef?: string; outputImageRef?: string }
      | undefined;
    if (sd) {
      rgb = sd.outputImage || sd.image || null;
      const ref = sd.outputImageRef || sd.imageRef;
      if (!rgb && ref) {
        rgb = await loadMediaById(ref, effectiveSaveDir, sd.imageRef ? "inputs" : "generations");
      }
    }
  }

  if (!rgb) {
    updateNodeData(node.id, { status: "error", error: "Connect an RGB image input" });
    throw new Error("image2GS: missing RGB image input");
  }
  // SHARP depth pipeline (API /generate). "sharp" = no depth; "exr_pixel" /
  // "exr_grade" need the EXR; "exr_grade" + "region" also needs an albedo AOV.
  const depthMethod = nodeData.depthMethod || "exr_pixel";
  const gradeSource = nodeData.gradeSource || "percentile";
  const gradeCurve = nodeData.gradeCurve || "affine";
  const needsDepth = depthMethod !== "sharp";
  const needsAlbedo = depthMethod === "exr_grade" && gradeSource === "region";
  if (needsDepth && !nodeData.depthExrRef) {
    updateNodeData(node.id, { status: "error", error: "Load a depth EXR on the node" });
    throw new Error("image2GS: missing depth EXR");
  }
  if (needsAlbedo && !nodeData.albedoImageRef) {
    updateNodeData(node.id, { status: "error", error: "Load an albedo image (exr_grade · region)" });
    throw new Error("image2GS: missing albedo for exr_grade/region");
  }
  if (!effectiveSaveDir) {
    updateNodeData(node.id, { status: "error", error: "Set a project save directory first" });
    throw new Error("image2GS: no saveDirectoryPath");
  }

  updateNodeData(node.id, {
    inputImages: [rgb],
    status: "loading",
    loadingStartedAt: Date.now(),
    loadingPhase: "Loading depth…",
    error: null,
    lastGenerationCost: null,
  });

  // Load the saved depth EXR bytes back from inputs/ (skipped for "sharp").
  let depthDataUrl: string | null = null;
  if (needsDepth) {
    depthDataUrl = await loadMediaById(nodeData.depthExrRef as string, effectiveSaveDir, "inputs");
    if (!depthDataUrl) {
      updateNodeData(node.id, { status: "error", error: "Depth EXR file not found in inputs/" });
      throw new Error("image2GS: depth EXR ref not resolvable");
    }
  }
  // Load the albedo AOV from inputs/ (only "exr_grade" + "region").
  let albedoDataUrl: string | null = null;
  if (needsAlbedo) {
    albedoDataUrl = await loadMediaById(nodeData.albedoImageRef as string, effectiveSaveDir, "inputs");
    if (!albedoDataUrl) {
      updateNodeData(node.id, { status: "error", error: "Albedo image not found in inputs/" });
      throw new Error("image2GS: albedo ref not resolvable");
    }
  }

  try {
    const rgbBlob = await urlToBlob(rgb);

    const form = new FormData();
    // Backend (/generate) requires the RGB field named "image" (not "rgb").
    form.append("image", rgbBlob, "rgb.png");
    form.append("depth_method", depthMethod);
    if (depthDataUrl) {
      const depthBlob = await urlToBlob(depthDataUrl);
      form.append("depth", depthBlob, nodeData.depthExrFilename || "depth.exr");
      // Harmless legacy field; the backend auto-reads the single-channel EXR.
      form.append("depth_channel", nodeData.selectedDepthChannel || "");
    }
    if (albedoDataUrl) {
      const albedoBlob = await urlToBlob(albedoDataUrl);
      form.append("albedo", albedoBlob, nodeData.albedoSourcePath || "albedo.png");
    }
    if (depthMethod === "exr_grade") {
      form.append("grade_source", gradeSource);
      form.append("grade_curve", gradeCurve);
      // Floor on the grade-curve slope (>= 0); 0 = off. Reduces 3DGS popping.
      form.append("grade_min_slope", String(Math.max(0, nodeData.gradeMinSlope ?? 0)));
    }
    form.append("focal_mm", String(nodeData.focalLengthMm ?? 24));
    form.append("aperture_mm", String(nodeData.apertureMm ?? 36));
    if (nodeData.fPxOverride != null) form.append("f_px", String(nodeData.fPxOverride));
    // blend_alpha is exr_pixel only (ignored by sharp, forced to 0 by exr_grade).
    if (depthMethod === "exr_pixel") form.append("blend_alpha", String(nodeData.blendAlpha ?? 0.4));

    updateNodeData(node.id, { loadingPhase: "Generating splat…" });

    const response = await fetch("/api/image2gs", {
      method: "POST",
      body: form,
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const j = await response.json();
        const e = j?.error ?? j?.detail;
        if (typeof e === "string" && e) msg = e;
        else if (e != null) msg = JSON.stringify(e); // never let an object stringify to "[object Object]"
      } catch {
        /* non-JSON error body */
      }
      updateNodeData(node.id, { status: "error", error: msg });
      throw new Error(msg);
    }

    const plyBlob = await response.blob();
    const blobUrl = URL.createObjectURL(plyBlob);

    const timestamp = Date.now();
    const model3dId = `${timestamp}`;
    const newHistoryItem: Carousel3DItem = {
      id: model3dId,
      timestamp,
      prompt: nodeData.depthExrFilename || "image2GS",
      model: "sharp-local",
    };
    const updatedHistory = [newHistoryItem, ...(nodeData.model3dHistory || [])].slice(0, 50);

    updateNodeData(node.id, {
      output3dUrl: blobUrl,
      status: "complete",
      error: null,
      model3dHistory: updatedHistory,
      selectedModel3dHistoryIndex: 0,
    });

    // ── Output naming + folder routing (SALACAK pipeline) ──
    // Name the .ply after the RGB; route by the RGB's source folder:
    //   …/outputs/Image/…  → <project>/outputs/GS   (promoted output)
    //   …/inputs/… or other → generations/          (working output)
    //   no source path/name → generations/ + timestamp (default)
    let outputDir = effectiveGenerationsPath;
    let outputStem = model3dId;
    const rgbPath = driveToUnc(nodeData.rgbSourcePath);
    if (rgbPath) {
      outputStem = filenameStem(rgbPath) || model3dId;
      const fwd = rgbPath.replace(/\\/g, "/");
      if (effectiveSaveDir && /\/outputs\/image\//i.test(fwd)) {
        outputDir = `${effectiveSaveDir.replace(/[\\/]+$/, "")}/outputs/GS`;
      }
    } else {
      // No explicit path — name the .ply after the upstream source's filename.
      const inEdge = getEdges().find(
        (e) => e.target === node.id && (e.targetHandle === "image" || (e.targetHandle ?? "").startsWith("image")),
      );
      const srcData = inEdge
        ? (getNodes().find((n) => n.id === inEdge.source)?.data as { filename?: string | null } | undefined)
        : undefined;
      if (srcData?.filename) outputStem = filenameStem(srcData.filename) || model3dId;
    }

    // Auto-save the .ply. Multipart with a `.ply` filename makes save-generation
    // preserve the extension + dedupe by hash; createDirectory makes outputs/GS.
    if (outputDir) {
      const saveForm = new FormData();
      saveForm.append("directoryPath", outputDir);
      saveForm.append("customFilename", outputStem);
      saveForm.append("createDirectory", "true");
      saveForm.append("file", new File([plyBlob], `${outputStem}.ply`, { type: "application/octet-stream" }));

      const savePromise = fetch("/api/save-generation", { method: "POST", body: saveForm })
        .then((res) => res.json())
        .then((saveResult) => {
          if (saveResult.success && saveResult.filename) {
            updateNodeData(node.id, {
              savedFilename: saveResult.filename,
              savedFilePath: saveResult.filePath,
            });
            // Sync the history id to the on-disk stem so reload can reload it.
            if (saveResult.imageId && saveResult.imageId !== model3dId) {
              const currentNode = getNodes().find((n) => n.id === node.id);
              if (currentNode) {
                const currentData = currentNode.data as Image2GSNodeData;
                const histCopy = [...(currentData.model3dHistory || [])];
                const entryIndex = histCopy.findIndex((h) => h.id === model3dId);
                if (entryIndex !== -1) {
                  histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                  updateNodeData(node.id, { model3dHistory: histCopy });
                }
              }
            }
          }
        })
        .catch((err) => {
          console.error("Failed to save splat .ply:", err);
        });

      trackSaveGeneration(model3dId, savePromise);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const msg = error instanceof Error ? error.message : "Splat generation failed";
    updateNodeData(node.id, { status: "error", error: msg });
    throw new Error(msg);
  }
}
