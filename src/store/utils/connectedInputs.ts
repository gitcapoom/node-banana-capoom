/**
 * Connected Inputs & Validation
 *
 * Pure functions extracted from workflowStore for getting connected inputs
 * and validating workflow structure. These can be tested without the store.
 */

import {
  WorkflowNode,
  WorkflowEdge,
  ImageInputNodeData,
  AudioInputNodeData,
  AnnotationNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  Generate3DNodeData,
  GenerateAudioNodeData,
  VideoStitchNodeData,
  EaseCurveNodeData,
  VideoTrimNodeData,
  VideoFrameGrabNodeData,
  PromptNodeData,
  ArrayNodeData,
  PromptConstructorNodeData,
  LLMGenerateNodeData,
  GLBViewerNodeData,
  SwitchNodeData,
  ConditionalSwitchNodeData,
  MatchMode,
  SpzViewerNodeData,
  WorldLabsPanoNodeData,
  WorldLabsWorldNodeData,
  PanoCropNodeData,
  PanoEditorNodeData,
  MaskPainterNodeData,
  VideoInputNodeData,
  ImageCropNodeData,
} from "@/types";
import { getDynamicPinsEnabled } from "@/lib/dynamicPins";
import { parseDynPin } from "@/lib/dynamicPinId";
import { translateReferenceTokens, replaceNamedTokens, slotToLetter, ordinalPhrase } from "@/lib/refTokens";

/**
 * Return type for getConnectedInputs
 */
export interface ConnectedInputs {
  images: string[];
  videos: string[];
  audio: string[];
  model3d: string | null;
  text: string | null;
  dynamicInputs: Record<string, string | string[]>;
  easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null; outputDuration: number } | null;
  /** Loopback: the image on the `image-feedback` handle (the previous
   *  generation), kept out of `images[]` so the executor can place it first. */
  feedbackImage?: string | null;
}

/**
 * Helper to determine if a handle ID is an image type
 */
function isImageHandle(handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  // "image", "image-mask_url", "image-depth_image_url", "image-0", etc.
  return handleId === "image" || handleId.startsWith("image-") || handleId.includes("frame");
}

/**
 * Helper to determine if a handle ID is a text type
 */
function isTextHandle(handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  return handleId === "text" || handleId.startsWith("text-") || handleId.includes("prompt");
}

/**
 * Extract output data and type from a source node.
 * sourceHandleId is used for multi-output nodes (e.g. WorldLabs outputs both "image" and "3d").
 */
export function getSourceOutput(
  sourceNode: WorkflowNode,
  sourceHandle: string | null | undefined,
  edgeData?: Record<string, unknown>
): { type: "image" | "text" | "video" | "audio" | "3d"; value: string | null } {
  const sourceHandleId = sourceHandle;
  if (sourceNode.type === "imageInput") {
    const d = sourceNode.data as ImageInputNodeData;
    // If a mirror toggle is active we pre-computed outputImage; return it.
    // Otherwise fall back to the raw image.
    const flipActive = !!d.flipHorizontal || !!d.flipVertical;
    return { type: "image", value: (flipActive && d.outputImage) ? d.outputImage : d.image };
  } else if (sourceNode.type === "audioInput") {
    return { type: "audio", value: (sourceNode.data as AudioInputNodeData).audioFile };
  } else if (sourceNode.type === "annotation") {
    return { type: "image", value: (sourceNode.data as AnnotationNodeData).outputImage };
  } else if (sourceNode.type === "nanoBanana") {
    const nbData = sourceNode.data as NanoBananaNodeData;
    return { type: "image", value: nbData.outputImage };
  } else if (sourceNode.type === "upscaleGrid") {
    const ugData = sourceNode.data as import("@/types").UpscaleGridNodeData;
    return { type: "image", value: ugData.outputImage };
  } else if (sourceNode.type === "generate3d") {
    const g3dData = sourceNode.data as Generate3DNodeData;
    return { type: "3d", value: g3dData.output3dUrl };
  } else if (sourceNode.type === "image2GS") {
    const gsData = sourceNode.data as import("@/types").Image2GSNodeData;
    return { type: "3d", value: gsData.output3dUrl };
  } else if (sourceNode.type === "generateVideo") {
    return { type: "video", value: (sourceNode.data as GenerateVideoNodeData).outputVideo };
  } else if (sourceNode.type === "generateAudio") {
    return { type: "audio", value: (sourceNode.data as GenerateAudioNodeData).outputAudio };
  } else if (sourceNode.type === "videoStitch") {
    return { type: "video", value: (sourceNode.data as VideoStitchNodeData).outputVideo };
  } else if (sourceNode.type === "easeCurve") {
    return { type: "video", value: (sourceNode.data as EaseCurveNodeData).outputVideo };
  } else if (sourceNode.type === "videoTrim") {
    return { type: "video", value: (sourceNode.data as VideoTrimNodeData).outputVideo };
  } else if (sourceNode.type === "prompt") {
    return { type: "text", value: (sourceNode.data as PromptNodeData).prompt };
  } else if (sourceNode.type === "array") {
    const arrayData = sourceNode.data as ArrayNodeData;
    const dataIndex = edgeData?.arrayItemIndex;
    if (typeof dataIndex === "number" && Number.isInteger(dataIndex) && dataIndex >= 0) {
      const items = arrayData.outputItems;
      if (items.length === 0) return { type: "text", value: null };
      const clampedIndex = dataIndex % items.length;
      return { type: "text", value: items[clampedIndex] ?? null };
    }
    if (sourceHandle?.startsWith("text-")) {
      const index = Number(sourceHandle.replace("text-", ""));
      if (Number.isInteger(index) && index >= 0) {
        return { type: "text", value: arrayData.outputItems[index] ?? null };
      }
    }
    return { type: "text", value: arrayData.outputText };
  } else if (sourceNode.type === "promptConstructor") {
    const pcData = sourceNode.data as PromptConstructorNodeData;
    return { type: "text", value: pcData.outputText ?? pcData.template ?? null };
  } else if (sourceNode.type === "llmGenerate") {
    const llmData = sourceNode.data as LLMGenerateNodeData;
    // Loopback mode exposes a second text output: the clean image prompt.
    if (sourceHandleId === "prompt") {
      return { type: "text", value: llmData.outputPrompt ?? null };
    }
    return { type: "text", value: llmData.outputText };
  } else if (sourceNode.type === "videoFrameGrab") {
    return { type: "image", value: (sourceNode.data as VideoFrameGrabNodeData).outputImage };
  } else if (sourceNode.type === "glbViewer") {
    return { type: "image", value: (sourceNode.data as GLBViewerNodeData).capturedImage };
  } else if (sourceNode.type === "spzViewer") {
    return { type: "image", value: (sourceNode.data as SpzViewerNodeData).capturedImage };
  } else if (sourceNode.type === "worldLabsPano") {
    const pData = sourceNode.data as WorldLabsPanoNodeData;
    if (sourceHandleId === "text") {
      return { type: "text", value: pData.caption || null };
    }
    return { type: "image", value: pData.panoUrl || pData.thumbnailUrl || null };
  } else if (sourceNode.type === "worldLabsWorld") {
    const wData = sourceNode.data as WorldLabsWorldNodeData;
    if (sourceHandleId === "3d") {
      const bestSpz = wData.spzUrls?.["500k"] || wData.spzUrls?.full_res || wData.spzUrls?.["100k"] || null;
      return { type: "3d", value: bestSpz };
    }
    return { type: "image", value: wData.panoUrl || wData.thumbnailUrl || null };
  } else if (sourceNode.type === "panoCrop") {
    const pcData = sourceNode.data as PanoCropNodeData;
    if (sourceHandleId === "text") {
      return { type: "text", value: pcData.metadata || null };
    }
    return { type: "image", value: pcData.image || null };
  } else if (sourceNode.type === "panoEditor") {
    return { type: "image", value: (sourceNode.data as PanoEditorNodeData).outputImage || null };
  } else if (sourceNode.type === "maskPainter") {
    return { type: "image", value: (sourceNode.data as MaskPainterNodeData).outputMask || null };
  } else if (sourceNode.type === "roto") {
    return { type: "image", value: (sourceNode.data as import("@/types").RotoNodeData).outputMask || null };
  } else if (sourceNode.type === "comp") {
    return { type: "image", value: (sourceNode.data as import("@/types").CompNodeData).outputImage || null };
  } else if (sourceNode.type === "videoInput") {
    return { type: "video", value: (sourceNode.data as VideoInputNodeData).videoFile };
  } else if (sourceNode.type === "imageCrop") {
    const icData = sourceNode.data as ImageCropNodeData;
    return { type: "image", value: icData.outputImage || icData.sourceImage || null };
  } else if (sourceNode.type === "sphereLightRender") {
    return { type: "image", value: (sourceNode.data as import("@/types").SphereLightRenderNodeData).outputImage || null };
  } else if (sourceNode.type === "mirror") {
    const mData = sourceNode.data as import("@/types").MirrorNodeData;
    return { type: "image", value: mData.outputImage || mData.sourceImage || null };
  } else if (sourceNode.type === "reformat") {
    const rData = sourceNode.data as import("@/types").ReformatNodeData;
    return { type: "image", value: rData.outputImage || rData.sourceImage || null };
  } else if (sourceNode.type === "cubemapEquirect") {
    const ceData = sourceNode.data as import("@/types").CubemapEquirectNodeData;
    return { type: "image", value: ceData.outputImage || ceData.sourceImage || null };
  } else if (sourceNode.type === "colorGrade") {
    const cgData = sourceNode.data as import("@/types").ColorGradeNodeData;
    return { type: "image", value: cgData.outputImage || cgData.sourceImage || null };
  } else if (sourceNode.type === "hsvCorrect") {
    const hData = sourceNode.data as import("@/types").HsvCorrectNodeData;
    return { type: "image", value: hData.outputImage || hData.sourceImage || null };
  } else if (sourceNode.type === "contrastAdjust") {
    const cData = sourceNode.data as import("@/types").ContrastAdjustNodeData;
    return { type: "image", value: cData.outputImage || cData.sourceImage || null };
  } else if (sourceNode.type === "blur") {
    const bData = sourceNode.data as import("@/types").BlurNodeData;
    return { type: "image", value: bData.outputImage || bData.sourceImage || null };
  } else if (sourceNode.type === "panoShift") {
    const psData = sourceNode.data as import("@/types").PanoShiftNodeData;
    return { type: "image", value: psData.outputImage || psData.sourceImage || null };
  } else if (sourceNode.type === "cubemapFaces") {
    const cfData = sourceNode.data as import("@/types").CubemapFacesNodeData;
    if (cfData.mode === "split") {
      // Six output handles, one per face — switch on sourceHandle.
      const map: Record<string, string | null | undefined> = {
        up: cfData.outputUp,
        down: cfData.outputDown,
        left: cfData.outputLeft,
        right: cfData.outputRight,
        front: cfData.outputFront,
        back: cfData.outputBack,
      };
      const value = (sourceHandleId && map[sourceHandleId]) || null;
      return { type: "image", value };
    }
    // Combine mode: single "image" output → the assembled cross.
    return { type: "image", value: cfData.outputCross || null };
  }
  return { type: "image", value: null };
}

/**
 * Get all connected inputs for a node.
 * Pure function version of workflowStore.getConnectedInputs.
 */
export function getConnectedInputsPure(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  visited?: Set<string>,
  dimmedNodeIds?: Set<string>
): ConnectedInputs {
  const _visited = visited || new Set<string>();
  if (_visited.has(nodeId)) return { images: [], videos: [], audio: [], model3d: null, text: null, dynamicInputs: {}, easeCurve: null };
  _visited.add(nodeId);
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  let model3d: string | null = null;
  let text: string | null = null;
  let feedbackImage: string | null = null;
  const dynamicInputs: Record<string, string | string[]> = {};
  const dynamicPinsOn = getDynamicPinsEnabled();
  let easeCurve: ConnectedInputs["easeCurve"] = null;

  // Get the target node to check for inputSchema
  const targetNode = nodes.find((n) => n.id === nodeId);
  const inputSchema = (targetNode?.data as {
    inputSchema?: Array<{
      name: string;
      type: string;
      isArray?: boolean;
      repeatable?: boolean;
      refConvention?: string;
      children?: Array<{ name: string; isArray?: boolean }>;
    }>;
  })?.inputSchema;

  // Determine whether a (possibly nested) dyn-pin field path expects an array.
  // Top-level array fields are in arraySchemaNames (built below); nested paths
  // like "elements.0.reference_image_urls" consult the repeatable group's child.
  const isArrayPath = (fieldPath: string): boolean => {
    if (arraySchemaNames.has(fieldPath)) return true;
    const m = fieldPath.match(/^(.+)\.\d+\.(.+)$/);
    if (m && inputSchema) {
      const group = inputSchema.find((i) => i.name === m[1] && i.repeatable);
      const child = group?.children?.find((c) => c.name === m[2]);
      if (child) return !!child.isArray;
    }
    return false;
  };

  // A field the loaded schema POSITIVELY declares as scalar (non-array).
  // Distinct from !isArrayPath: with no schema loaded we can't judge, and
  // multi-slot aggregation must stay the default there.
  const isKnownScalarPath = (fieldPath: string): boolean => {
    if (!inputSchema || inputSchema.length === 0) return false;
    const m = fieldPath.match(/^(.+)\.\d+\.(.+)$/);
    if (m) {
      const group = inputSchema.find((i) => i.name === m[1] && i.repeatable);
      const child = group?.children?.find((c) => c.name === m[2]);
      return !!child && !child.isArray;
    }
    const top = inputSchema.find((i) => i.name === fieldPath);
    return !!top && !top.isArray;
  };

  // Build mapping from normalized handle IDs to schema names if schema exists
  const handleToSchemaName: Record<string, string> = {};
  // Track which schema fields require arrays (isArray: true in schema)
  const arraySchemaNames = new Set<string>();
  if (inputSchema && inputSchema.length > 0) {
    const imageInputs = inputSchema.filter(i => i.type === "image");
    const textInputs = inputSchema.filter(i => i.type === "text");
    const videoInputs = inputSchema.filter(i => i.type === "video");
    const audioInputs = inputSchema.filter(i => i.type === "audio");

    // Map handles to schema names for each type.
    // Convention: first handle = bare type ("image"), extras = "image-1", "image-2", etc.
    // Also keep legacy formats for backward compat.
    const mapHandles = (inputs: Array<{ name: string }>, handleType: string) => {
      inputs.forEach((input, index) => {
        // Current convention: first = bare type, extras = type-N
        const handleId = index === 0 ? handleType : `${handleType}-${index}`;
        handleToSchemaName[handleId] = input.name;
        // Legacy: "type-{schemaName}" format
        handleToSchemaName[`${handleType}-${input.name}`] = input.name;
        // Legacy: "type-{index}" indexed from 0 ("image-0" = first input).
        // loadWorkflow migrates these, but edges can bypass it (importWorkflow,
        // paste). For index > 0 this duplicates the current convention.
        handleToSchemaName[`${handleType}-${index}`] = input.name;
      });
    };

    mapHandles(imageInputs, "image");
    mapHandles(textInputs, "text");
    mapHandles(videoInputs, "video");
    mapHandles(audioInputs, "audio");

    // Collect schema fields that require array values (isArray: true)
    for (const input of inputSchema) {
      if ((input as { isArray?: boolean }).isArray) {
        arraySchemaNames.add(input.name);
      }
    }

    // Legacy: map "image-mask" to mask schema name for backwards compatibility
    const maskInput = inputSchema.find(i => i.name.includes("mask") && i.type === "image");
    if (maskInput) {
      handleToSchemaName["image-mask"] = maskInput.name;
    }
  }

  // Process edges in dyn-pin slot order so multi-value arrays are assembled
  // top-to-bottom (so position 1 = topmost pin = @Image1). Same-field dyn-pin
  // edges sort by slot; everything else keeps its original relative order.
  const incomingEdges = edges.filter((edge) => edge.target === nodeId);
  if (dynamicPinsOn) {
    incomingEdges.sort((a, b) => {
      const da = parseDynPin(a.targetHandle);
      const db = parseDynPin(b.targetHandle);
      if (da && db && da.type === db.type && da.field === db.field) return da.slot - db.slot;
      return 0;
    });
  }

  // Repeatable groups (e.g. Kling `elements`): map each connected item index to
  // its DENSE rank so the assembled array has no holes and @Element{n} lines up
  // with array position. Item indices are stable; ranks are positional.
  const groupItemRanks = new Map<string, Map<number, number>>();
  if (dynamicPinsOn && inputSchema) {
    for (const input of inputSchema) {
      if (!input.repeatable) continue;
      const prefix = `${input.name}.`;
      const items = new Set<number>();
      for (const e of incomingEdges) {
        const d = parseDynPin(e.targetHandle);
        if (d && d.field.startsWith(prefix)) {
          const idx = Number(d.field.slice(prefix.length).split(".")[0]);
          if (Number.isInteger(idx)) items.add(idx);
        }
      }
      const rankMap = new Map<number, number>();
      [...items].sort((a, b) => a - b).forEach((idx, rank) => rankMap.set(idx, rank));
      groupItemRanks.set(input.name, rankMap);
    }
  }

  // Rewrite a group-child path's stable item index to its dense rank, so the
  // payload array is contiguous: elements.2.video_url -> elements.1.video_url.
  const remapFieldPath = (fieldPath: string): string => {
    for (const [groupName, rankMap] of groupItemRanks) {
      const prefix = `${groupName}.`;
      if (!fieldPath.startsWith(prefix)) continue;
      const rest = fieldPath.slice(prefix.length);
      const dot = rest.indexOf(".");
      if (dot <= 0) continue;
      const rank = rankMap.get(Number(rest.slice(0, dot)));
      if (rank !== undefined) return `${groupName}.${rank}.${rest.slice(dot + 1)}`;
    }
    return fieldPath;
  };

  // Fields already fed by an explicit dyn-pin edge. A LEGACY-handle edge
  // (e.g. an orphaned bare "image" edge left behind by a rewire — invisible on
  // the canvas because the handle no longer renders) must never ALSO feed the
  // same field: arraying ghost + live values made providers unwrap [0], the
  // stale ghost. Live pins categorically outrank legacy-handle mappings.
  const dynFedFields = new Set<string>();
  if (dynamicPinsOn) {
    for (const e of incomingEdges) {
      const d = parseDynPin(e.targetHandle);
      if (d && d.field !== "primary") dynFedFields.add(remapFieldPath(d.field));
    }
  }

  incomingEdges
    .forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      // Skip dimmed source nodes — their data should not flow downstream
      if (dimmedNodeIds && dimmedNodeIds.has(sourceNode.id)) return;

      // Router passthrough — traverse upstream to find actual data source
      if (sourceNode.type === "router") {
        const routerInputs = getConnectedInputsPure(sourceNode.id, nodes, edges, _visited, dimmedNodeIds);
        // Determine which type this edge carries based on the source handle
        const edgeType = edge.sourceHandle; // Will be "image", "text", "video", "audio", "3d", or "easeCurve"
        const routerTargetHandle = edge.targetHandle;
        // Resolve the destination field: legacy handle map, or a dyn-pin field
        // (e.g. router → generator's image_urls pin). "primary" stays generic.
        const routerDyn = routerTargetHandle ? parseDynPin(routerTargetHandle) : null;
        const schemaName =
          (routerTargetHandle ? handleToSchemaName[routerTargetHandle] : undefined) ||
          (routerDyn && routerDyn.field !== "primary" ? routerDyn.field : undefined);

        // Helper to route router values to both generic arrays AND schema-named dynamicInputs
        const routeRouterValues = (values: unknown[]) => {
          if (schemaName && values.length > 0) {
            // Route to dynamicInputs under schema field name
            const existing = dynamicInputs[schemaName];
            if (existing !== undefined) {
              const existingArr = Array.isArray(existing) ? existing : [existing];
              dynamicInputs[schemaName] = [...existingArr, ...values as string[]];
            } else {
              dynamicInputs[schemaName] = arraySchemaNames.has(schemaName)
                ? (values as string[])
                : (values.length === 1 ? (values[0] as string) : (values as string[]));
            }
          }
        };

        if (edgeType === "image" || (!edgeType && isImageHandle(edge.sourceHandle))) {
          images.push(...routerInputs.images);
          routeRouterValues(routerInputs.images);
        } else if (edgeType === "text" || (!edgeType && isTextHandle(edge.sourceHandle))) {
          if (routerInputs.text) {
            text = routerInputs.text;
            if (schemaName) dynamicInputs[schemaName] = routerInputs.text;
          }
        } else if (edgeType === "video") {
          videos.push(...routerInputs.videos);
          routeRouterValues(routerInputs.videos);
        } else if (edgeType === "audio") {
          audio.push(...routerInputs.audio);
          routeRouterValues(routerInputs.audio);
        } else if (edgeType === "3d") {
          if (routerInputs.model3d) {
            model3d = routerInputs.model3d;
            if (schemaName) dynamicInputs[schemaName] = routerInputs.model3d;
          }
        } else if (edgeType === "easeCurve") {
          // EaseCurve passthrough
          if (routerInputs.easeCurve) easeCurve = routerInputs.easeCurve;
        }
        return; // Skip normal getSourceOutput processing for this edge
      }

      // Switch passthrough — traverse upstream if output is enabled
      if (sourceNode.type === "switch") {
        const switchData = sourceNode.data as SwitchNodeData;
        const switchId = edge.sourceHandle; // Handle ID matches switch entry id
        const switchEntry = switchData.switches?.find(s => s.id === switchId);

        // Skip disabled outputs — data does not flow through disabled switches
        if (!switchEntry || !switchEntry.enabled) {
          return; // Block this path
        }

        // Enabled switch: recursively get upstream data (same pattern as router)
        const switchInputs = getConnectedInputsPure(sourceNode.id, nodes, edges, _visited, dimmedNodeIds);
        const edgeType = switchData.inputType;
        const switchTargetHandle = edge.targetHandle;
        const switchSchemaName = switchTargetHandle ? handleToSchemaName[switchTargetHandle] : undefined;

        const routeSwitchValues = (values: unknown[]) => {
          if (switchSchemaName && values.length > 0) {
            const existing = dynamicInputs[switchSchemaName];
            if (existing !== undefined) {
              const existingArr = Array.isArray(existing) ? existing : [existing];
              dynamicInputs[switchSchemaName] = [...existingArr, ...values as string[]];
            } else {
              dynamicInputs[switchSchemaName] = arraySchemaNames.has(switchSchemaName)
                ? (values as string[])
                : (values.length === 1 ? (values[0] as string) : (values as string[]));
            }
          }
        };

        if (edgeType === "image") {
          images.push(...switchInputs.images);
          routeSwitchValues(switchInputs.images);
        } else if (edgeType === "text") {
          if (switchInputs.text) {
            text = switchInputs.text;
            if (switchSchemaName) dynamicInputs[switchSchemaName] = switchInputs.text;
          }
        } else if (edgeType === "video") {
          videos.push(...switchInputs.videos);
          routeSwitchValues(switchInputs.videos);
        } else if (edgeType === "audio") {
          audio.push(...switchInputs.audio);
          routeSwitchValues(switchInputs.audio);
        } else if (edgeType === "3d") {
          if (switchInputs.model3d) {
            model3d = switchInputs.model3d;
            if (switchSchemaName) dynamicInputs[switchSchemaName] = switchInputs.model3d;
          }
        } else if (edgeType === "easeCurve") {
          if (switchInputs.easeCurve) easeCurve = switchInputs.easeCurve;
        }
        return; // Skip normal getSourceOutput processing
      }

      // Conditional Switch passthrough — traverse upstream if output is active (matched or default)
      if (sourceNode.type === "conditionalSwitch") {
        const condData = sourceNode.data as ConditionalSwitchNodeData;

        // When evaluation is paused, all outputs are active (gate is open)
        if (!condData.evaluationPaused) {
          const sourceHandle = edge.sourceHandle;

          // Find matching rule or check if default
          const rule = condData.rules.find(r => r.id === sourceHandle);
          const isDefaultHandle = sourceHandle === "default";

          // Determine if this output is active
          let isActive = false;
          if (rule) {
            isActive = rule.isMatched;
          } else if (isDefaultHandle) {
            // Default is active when NO rules match
            isActive = !condData.rules.some(r => r.isMatched);
          }

          // Block non-active outputs (data does not flow through non-matching rules)
          if (!isActive) return;
        }

        // Active output (or paused): ConditionalSwitch is a gate — trigger downstream but don't pass data through
        return;
      }

      // Loopback references passthrough. A single edge from a loopback LLM's
      // `images` output carries the WHOLE ordered image list the LLM saw
      // (feedback first, then references) — i.e. exactly the "Image 1 / Image 2
      // / …" its prompt refers to.
      //
      // Delivery differs by pin model:
      //  • Classic pins (static handles): the generic images[] array natively
      //    carries multiple images, and the provider maps it to the model's
      //    image param — so images.push is enough.
      //  • Dynamic pins: each pin is ONE slot and the provider builds its
      //    request from dynamicInputs (ignoring images[] on Fal). A single edge
      //    can't fan across slots, so we deliberately fill the WHOLE target
      //    array field from this one edge — set dynamicInputs[field] to the
      //    ordered list. (This is the intended "single edge = all references".)
      // We do both so it works regardless of the model's dispatch path.
      if (sourceNode.type === "llmGenerate" && edge.sourceHandle === "images") {
        const llmData = sourceNode.data as LLMGenerateNodeData;
        const list = (llmData.inputImages ?? []).filter(
          (s): s is string => typeof s === "string" && s.length > 0
        );
        const dyn = parseDynPin(edge.targetHandle);
        if (dyn && dyn.field !== "primary") {
          dynamicInputs[remapFieldPath(dyn.field)] = list;
        }
        for (const img of list) images.push(img);
        return;
      }

      const handleId = edge.targetHandle;
      const { type, value } = getSourceOutput(
        sourceNode,
        edge.sourceHandle,
        (edge.data as Record<string, unknown> | undefined)
      );

      if (!value) return;

      // Background image handle — visual only, not a model input
      if (handleId === "image-bg") return;

      // Loopback feedback image (the previous generation). Kept separate from
      // images[] so the executor can place it as Image 1; last one wins.
      if (handleId === "image-feedback") {
        feedbackImage = typeof value === "string" ? value : String(value);
        return;
      }

      // New dynamic-pin model: dynpin__{type}__{field}__{slot}. Each slot is
      // one value of a (possibly array) field. Route it back into the same
      // images[]/dynamicInputs[field] arrays the rest of the pipeline expects,
      // so executors and the API layer are unchanged.
      if (dynamicPinsOn) {
        const dyn = parseDynPin(handleId);
        if (dyn) {
          if (dyn.field !== "primary") {
            const fieldKey = remapFieldPath(dyn.field);
            const existing = dynamicInputs[fieldKey];
            if (isKnownScalarPath(fieldKey)) {
              // Schema says SCALAR: only slot 0 renders a pin, so multiple
              // slots are rewire leftovers (ghost edges — React Flow #008).
              // Edges are slot-sorted above → last write = highest slot = the
              // newest wiring. Arraying them made providers unwrap [0], the
              // stale ghost.
              dynamicInputs[fieldKey] = value;
            } else if (existing !== undefined) {
              // A second slot's value for this field — it must be an array.
              dynamicInputs[fieldKey] = Array.isArray(existing)
                ? [...existing, value]
                : [existing, value];
            } else if (isArrayPath(fieldKey)) {
              dynamicInputs[fieldKey] = [value];
            } else {
              // Scalar field (single slot) — keep the raw value so the provider
              // receives a string, not a 1-element array.
              dynamicInputs[fieldKey] = value;
            }
          }
          if (dyn.type === "3d") model3d = value;
          else if (dyn.type === "video") videos.push(value);
          else if (dyn.type === "audio") audio.push(value);
          else if (dyn.type === "text") text = typeof value === "string" ? value : String(value);
          else images.push(value);
          return;
        }
      }

      // Map normalized handle ID to schema name for dynamicInputs. Skipped
      // when a live dyn-pin edge already feeds this field — legacy-handle
      // edges (incl. invisible orphans left behind by rewires, whose handles
      // no longer render) must never override or pollute live pins.
      if (handleId && handleToSchemaName[handleId] && !dynFedFields.has(handleToSchemaName[handleId])) {
        const schemaName = handleToSchemaName[handleId];
        const existing = dynamicInputs[schemaName];
        if (existing !== undefined) {
          dynamicInputs[schemaName] = Array.isArray(existing)
            ? [...existing, value]
            : [existing, value];
        } else {
          // If schema declares this field as isArray, always wrap in array
          dynamicInputs[schemaName] = arraySchemaNames.has(schemaName) ? [value] : value;
        }
      }

      // Route to typed arrays based on source output type
      if (type === "3d") {
        model3d = value;
      } else if (type === "video") {
        videos.push(value);
      } else if (type === "audio") {
        audio.push(value);
      } else if (type === "text" || isTextHandle(handleId)) {
        // Defensive: ensure text values are always strings
        // (Guards against corrupted node data during parallel execution)
        text = typeof value === 'string' ? value : String(value);
      } else if (type === "image" || isImageHandle(handleId) || !handleId) {
        images.push(value);
      }
    });

  // Extract easeCurve data from parent EaseCurve node (if not already set by router passthrough)
  if (!easeCurve) {
    const easeCurveEdge = edges.find(
      (e) => e.target === nodeId && e.targetHandle === "easeCurve"
    );
    if (easeCurveEdge) {
      const sourceNode = nodes.find((n) => n.id === easeCurveEdge.source);
      if (sourceNode?.type === "easeCurve") {
        const sourceData = sourceNode.data as EaseCurveNodeData;
        easeCurve = {
          bezierHandles: sourceData.bezierHandles,
          easingPreset: sourceData.easingPreset,
          outputDuration: sourceData.outputDuration,
        };
      }
    }
  }

  // Stable reference tokens (e.g. @ImageA) → positional tokens (@Image1) for the
  // OUTGOING prompt, based on each input's CURRENT position. The authored prompt
  // node text is never modified — only the resolved text sent to generation.
  if (dynamicPinsOn && text && inputSchema) {
    let resolved: string = text;
    for (const input of inputSchema) {
      // Router-fed array field: resolve the prompt's router tokens (@A / @Hero)
      // using the router's image-slot order. With an @-convention → positional
      // tokens (@Image1); without → ordinal phrases a description-based model
      // understands ("the first image"). Single-router, image-first.
      const routerEdge =
        input.isArray
          ? incomingEdges.find((e) => {
              const d = parseDynPin(e.targetHandle);
              if (!d || d.field !== input.name) return false;
              return nodes.find((n) => n.id === e.source)?.type === "router";
            })
          : undefined;
      if (routerEdge) {
        const routerId = routerEdge.source;
        const refNames =
          (nodes.find((n) => n.id === routerId)?.data as { refNames?: Record<string, string> } | undefined)
            ?.refNames || {};
        const rslots: number[] = [];
        for (const e of edges) {
          if (e.target !== routerId) continue;
          const d = parseDynPin(e.targetHandle);
          if (d && d.type === "image" && d.field === "primary") rslots.push(d.slot);
        }
        rslots.sort((a, b) => a - b);
        const noun = input.type === "video" ? "video" : "image";
        const map: Record<string, string> = {};
        rslots.forEach((slot, rank) => {
          const tok = refNames[String(slot)] || slotToLetter(slot);
          map[`@${tok}`] = input.refConvention
            ? `@${input.refConvention}${rank + 1}`
            : ordinalPhrase(rank + 1, noun);
        });
        resolved = replaceNamedTokens(resolved, map);
        continue;
      }

      if (!input.refConvention) continue;

      if (input.isArray) {
        // Top-level array field (@ImageA → @Image1): tokens index by slot.
        const slots: number[] = [];
        for (const e of incomingEdges) {
          const d = parseDynPin(e.targetHandle);
          if (d && d.field === input.name) slots.push(d.slot);
        }
        slots.sort((a, b) => a - b);
        resolved = translateReferenceTokens(resolved, input.refConvention, slots);
      } else if (input.repeatable) {
        // Repeatable group (@ElementA → @Element1): tokens index by item index;
        // rankMap keys are already the connected item indices in ascending order.
        const items = [...(groupItemRanks.get(input.name)?.keys() ?? [])];
        resolved = translateReferenceTokens(resolved, input.refConvention, items);
      }
    }
    text = resolved;
  }

  return { images, videos, audio, model3d, text, dynamicInputs, easeCurve, feedbackImage };
}

/**
 * Validate workflow structure.
 * Pure function version of workflowStore.validateWorkflow.
 */
export function validateWorkflowPure(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (nodes.length === 0) {
    errors.push("Workflow is empty");
    return { valid: false, errors };
  }

  // Check each Nano Banana node has required inputs (text required, image optional)
  nodes
    .filter((n) => n.type === "nanoBanana")
    .forEach((node) => {
      const textConnected = edges.some(
        (e) => e.target === node.id &&
               (e.targetHandle === "text" || e.targetHandle?.startsWith("text-"))
      );
      if (!textConnected) {
        errors.push(`Generate node "${node.id}" missing text input`);
      }
    });

  // Check generateVideo nodes have required text input
  nodes
    .filter((n) => n.type === "generateVideo")
    .forEach((node) => {
      const textConnected = edges.some(
        (e) => e.target === node.id &&
               (e.targetHandle === "text" || e.targetHandle?.startsWith("text-"))
      );
      if (!textConnected) {
        errors.push(`Video node "${node.id}" missing text input`);
      }
    });

  // Check annotation nodes have image input (either connected or manually loaded)
  nodes
    .filter((n) => n.type === "annotation")
    .forEach((node) => {
      const imageConnected = edges.some((e) => e.target === node.id);
      const hasManualImage = (node.data as AnnotationNodeData).sourceImage !== null;
      if (!imageConnected && !hasManualImage) {
        errors.push(`Annotation node "${node.id}" missing image input`);
      }
    });

  // Check output nodes have image input
  nodes
    .filter((n) => n.type === "output")
    .forEach((node) => {
      const imageConnected = edges.some((e) => e.target === node.id);
      if (!imageConnected) {
        errors.push(`Output node "${node.id}" missing image input`);
      }
    });

  return { valid: errors.length === 0, errors };
}
