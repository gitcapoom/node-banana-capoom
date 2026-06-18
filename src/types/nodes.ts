/**
 * Node Types
 *
 * Types for workflow nodes including all node data interfaces,
 * handle types, and workflow node definitions.
 */

import { Node } from "@xyflow/react";
import type {
  AnnotationNodeData,
  AnnotationShape,
  BaseNodeData,
} from "./annotation";
import type { MaskPainterNodeData } from "./maskPainter";
import type { RotoNodeData } from "./roto";
import type { CompNodeData } from "./comp";

// Re-export types from annotation and mask painter for convenience
export type { AnnotationNodeData, BaseNodeData };
export type { MaskPainterNodeData };
export type { RotoNodeData };
export type { CompNodeData };

// Import from domain files to avoid circular dependencies
import type { AspectRatio, Resolution, ModelType } from "./models";
import type { LLMProvider, LLMModelType, SelectedModel, ProviderType } from "./providers";

/**
 * All available node types in the workflow editor
 */
export type NodeType =
  | "imageInput"
  | "audioInput"
  | "annotation"
  | "prompt"
  | "array"
  | "promptConstructor"
  | "nanoBanana"
  | "generateVideo"
  | "generateAudio"
  | "llmGenerate"
  | "splitGrid"
  | "output"
  | "outputGallery"
  | "imageCompare"
  | "videoCompare"
  | "videoStitch"
  | "easeCurve"
  | "videoTrim"
  | "videoFrameGrab"
  | "router"
  | "switch"
  | "conditionalSwitch"
  | "generate3d"
  | "image2GS"
  | "glbViewer"
  | "spzViewer"
  | "worldLabsPano"
  | "worldLabsWorld"
  | "panoCrop"
  | "panoViewer"
  | "panoEditor"
  | "maskPainter"
  | "roto"
  | "comp"
  | "videoInput"
  | "imageCrop"
  | "mirror"
  | "reformat"
  | "cubemapEquirect"
  | "cubemapFaces"
  | "colorGrade"
  | "hsvCorrect"
  | "contrastAdjust"
  | "panoShift";

/**
 * Node execution status
 */
export type NodeStatus = "idle" | "loading" | "complete" | "error";

/**
 * Image input node - loads/uploads images into the workflow
 */
export interface ImageInputNodeData extends BaseNodeData {
  image: string | null;
  imageRef?: string; // External image reference for storage optimization
  imageThumb?: string; // Inline small preview; shown on open when full-res not loaded
  filename: string | null;
  dimensions: { width: number; height: number } | null;
  /** When true, the output image is flipped horizontally before downstream use. */
  flipHorizontal?: boolean;
  /** When true, the output image is flipped vertically before downstream use. */
  flipVertical?: boolean;
  /**
   * Pre-rendered mirrored copy of `image` when a flip is active. Stored so
   * getSourceOutput can return it synchronously without needing a canvas op.
   */
  outputImage?: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Audio input node - loads/uploads audio files into the workflow
 */
export interface AudioInputNodeData extends BaseNodeData {
  audioFile: string | null;      // Base64 data URL of the audio file
  filename: string | null;       // Original filename for display
  duration: number | null;       // Duration in seconds
  format: string | null;         // MIME type (audio/mp3, audio/wav, etc.)
}

/**
 * Video input node - loads/uploads video files into the workflow
 */
export interface VideoInputNodeData extends BaseNodeData {
  videoFile: string | null;      // Base64 data URL of the video file
  videoFileRef?: string;         // External ref to video saved in inputs/
  thumbnailImage?: string | null; // First frame thumbnail for canvas display
  thumbnailImageRef?: string;    // External ref to thumbnail saved in inputs/
  filename: string | null;       // Original filename for display
  duration: number | null;       // Duration in seconds
  format: string | null;         // MIME type (video/mp4, video/webm, etc.)
}

/**
 * Image Crop node - crops an input image using a persisted relative region.
 * The crop region is stored in relative coordinates (0-1) so it auto-applies
 * to any new input image regardless of resolution.
 */
export type ImageCropAspectLock = "free" | "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export interface ImageCropNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  sourceImageThumb?: string;
  /** Crop region in relative coordinates (0-1 range) */
  cropRegion: { x: number; y: number; width: number; height: number } | null;
  aspectLock: ImageCropAspectLock;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Mirror node - flip an input image horizontally, vertically, or both.
 * Operation is applied whenever sourceImage or the flip toggles change.
 */
export interface MirrorNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  sourceImageThumb?: string;
  flipHorizontal: boolean;
  flipVertical: boolean;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

export interface ReformatNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  sourceImageThumb?: string;
  width: number;   // H (horizontal) output resolution
  height: number;  // V (vertical) output resolution
  mode: "fill" | "fitH" | "fitV";
  /** Interpolation filter (Nuke-style). Defaults to "cubic". */
  filter?: import("@/utils/resampleFilters").ResampleFilter;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Cubemap ⇄ Equirectangular conversion node.
 *
 * mode = "cubeToEquirect": input is a 4×3 cubemap cross, output is a 2:1
 *   equirectangular pano of width `outputSize`.
 * mode = "equirectToCube": input is a 2:1 equirect, output is a cubemap
 *   cross of (4 × outputSize) × (3 × outputSize).
 */
export type CubemapEquirectMode = "cubeToEquirect" | "equirectToCube";
export interface CubemapEquirectNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  sourceImageThumb?: string;
  mode: CubemapEquirectMode;
  /** Equirect width (cube→pano) or face size (pano→cube). */
  outputSize: number;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Color Grade node — Nuke-style Grade with per-channel controls.
 *
 * Each parameter is stored as a 3-channel value. When r === g === b the
 * UI shows a single master slider; users can split the row to tune R/G/B
 * independently and use the colour picker to assign all three at once.
 *
 * Numbers (instead of {r,g,b}) are accepted on load for backward compat
 * with workflows saved before per-channel was added — coerceChannel()
 * normalises them at runtime.
 */
export interface GradeChannelValue {
  r: number;
  g: number;
  b: number;
}
export interface ColorGradeNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  blackpoint: GradeChannelValue | number;
  whitepoint: GradeChannelValue | number;
  lift: GradeChannelValue | number;
  gain: GradeChannelValue | number;
  multiply: GradeChannelValue | number;
  offset: GradeChannelValue | number;
  gamma: GradeChannelValue | number;
  /** Clamp the low / high end of the output to 0 / 1. Default false so
   *  values pass through un-clamped to the next color node (float chain).
   *  The 8-bit thumbnail / non-color output always clamps regardless. */
  clampBlacks?: boolean;
  clampWhites?: boolean;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * HSV Color Correct node — hue shift / saturation / value adjustments.
 * GPU-native; sliders preview live.
 */
export interface HsvCorrectNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  /** Degrees [-180..180]; 0 = unchanged. */
  hueShift: number;
  /** Multiplier; 1 = unchanged, 0 = greyscale, 2 = doubled. */
  saturation: number;
  /** Multiplier; 1 = unchanged. */
  value: number;
  clampBlacks?: boolean;
  clampWhites?: boolean;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Contrast Adjust node — S-curve contrast with smooth roll-off so
 * highlights and shadows don't clip abruptly. GPU-native; live preview.
 */
export interface ContrastAdjustNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  /** Multiplier on (in - pivot); 1 = unchanged, <1 flattens, >1 punches. */
  contrast: number;
  /** 0..1. 0 = linear (unbounded — passes float through).
   *  1 = full S-curve, asymptotic soft-clip. */
  rolloff: number;
  /** 0..1. Pivot of the S-curve. 0.5 = neutral grey midpoint. */
  pivot: number;
  clampBlacks?: boolean;
  clampWhites?: boolean;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Pano Shift node — horizontal pixel shift with seam wrap-around.
 * Primarily for re-aligning equirectangular panoramas; works on any image.
 */
export interface PanoShiftNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  sourceImageThumb?: string;
  /** Pixels to shift right (positive) or left (negative). */
  shiftX: number;
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string;
}

/**
 * Cubemap ⇄ 6 individual face images.
 *
 * mode = "split": one image input (a 4×3 cross), six image outputs (the
 *   six faces, each `outputSize` square).
 * mode = "combine": six image inputs (one per face), one image output (a
 *   cubemap cross with face size `outputSize`).
 */
export type CubemapFacesMode = "split" | "combine";
export interface CubemapFacesNodeData extends BaseNodeData {
  mode: CubemapFacesMode;
  /** Face size (pixels per face) for outputs. Default 1024. */
  outputSize: number;
  // Split-mode state
  sourceImage: string | null;
  sourceImageRef?: string;
  outputUp: string | null;
  outputUpRef?: string;
  outputDown: string | null;
  outputDownRef?: string;
  outputLeft: string | null;
  outputLeftRef?: string;
  outputRight: string | null;
  outputRightRef?: string;
  outputFront: string | null;
  outputFrontRef?: string;
  outputBack: string | null;
  outputBackRef?: string;
  // Combine-mode state
  outputCross: string | null;
  outputCrossRef?: string;
}

/**
 * Prompt node - text input for AI generation
 */
export interface PromptNodeData extends BaseNodeData {
  prompt: string;
  variableName?: string; // Optional variable name for use in PromptConstructor templates
}

export type ArraySplitMode = "delimiter" | "newline" | "regex";

/**
 * Array node - converts one text input into ordered text items.
 */
export interface ArrayNodeData extends BaseNodeData {
  inputText: string | null;
  splitMode: ArraySplitMode;
  delimiter: string;
  regexPattern: string;
  trimItems: boolean;
  removeEmpty: boolean;
  selectedOutputIndex: number | null;
  outputItems: string[];
  outputText: string | null; // JSON array string for the primary text output
  error: string | null;
}

/**
 * Prompt Constructor node - template-based prompt builder with @variable interpolation
 */
export interface PromptConstructorNodeData extends BaseNodeData {
  template: string;
  outputText: string | null;
  unresolvedVars: string[];
}

/**
 * Available variable from connected Prompt nodes (for PromptConstructor autocomplete)
 */
export interface AvailableVariable {
  name: string;
  value: string;
  nodeId: string;
}

/**
 * Image history item for tracking generated images
 */
export interface ImageHistoryItem {
  id: string;
  image: string; // Base64 data URL
  timestamp: number; // For display & sorting
  prompt: string; // The prompt used
  aspectRatio: AspectRatio;
  model: ModelType;
}

/**
 * Carousel image item for per-node history (IDs only, images stored externally)
 */
export interface CarouselImageItem {
  id: string;
  timestamp: number;
  prompt: string;
  aspectRatio: AspectRatio;
  model: ModelType;
  // Settings snapshot for recall when browsing history
  resolution?: Resolution;
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  useGoogleSearch?: boolean;
  useImageSearch?: boolean;
}

/**
 * Carousel video item for per-node video history
 */
export interface CarouselVideoItem {
  id: string;
  timestamp: number;
  prompt: string;
  model: string; // Model ID for video (not ModelType since external providers)
  // Settings snapshot for recall when browsing history
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  thumbnailId?: string; // ref to first-frame thumbnail in generations folder
}

/**
 * Model input definition for dynamic handles
 */
export interface ModelInputDef {
  name: string;
  type: "image" | "text" | "video" | "audio";
  required: boolean;
  label: string;
  description?: string;
}

/**
 * Nano Banana node - AI image generation
 */
export interface NanoBananaNodeData extends BaseNodeData {
  inputImages: string[]; // Now supports multiple images
  inputImageRefs?: string[]; // External image references for storage optimization
  inputPrompt: string | null;
  outputImage: string | null;
  outputImageRef?: string; // External image reference for storage optimization
  aspectRatio: AspectRatio;
  resolution: Resolution; // Only used by Nano Banana Pro
  model: ModelType;
  selectedModel?: SelectedModel; // Multi-provider model selection (optional for backward compat)
  useGoogleSearch: boolean; // Only available for Nano Banana Pro and Nano Banana 2
  useImageSearch: boolean; // Only available for Nano Banana 2
  parameters?: Record<string, unknown>; // Model-specific parameters for external providers
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  imageHistory: CarouselImageItem[]; // Carousel history (IDs only)
  selectedHistoryIndex: number; // Currently selected image in carousel
  lastGenerationCost?: number | null; // Cost of the last generation run
}

/**
 * Generate Video node - AI video generation
 */
export interface GenerateVideoNodeData extends BaseNodeData {
  inputImages: string[];
  inputImageRefs?: string[]; // External image references for storage optimization
  inputPrompt: string | null;
  outputVideo: string | null; // Video data URL or URL
  outputVideoRef?: string; // External video reference for storage optimization
  thumbnailImage?: string | null; // First frame thumbnail for canvas display
  thumbnailImageRef?: string; // External ref to thumbnail saved in generations/
  selectedModel?: SelectedModel; // Required for video generation (no legacy fallback)
  parameters?: Record<string, unknown>; // Model-specific parameters
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  videoHistory: CarouselVideoItem[]; // Carousel history (IDs only)
  selectedVideoHistoryIndex: number; // Currently selected video in carousel
  lastGenerationCost?: number | null; // Cost of the last generation run
}

/**
 * Generate 3D node - AI 3D model generation
 */
export interface Generate3DNodeData extends BaseNodeData {
  inputImages: string[];
  inputImageRefs?: string[];
  inputPrompt: string | null;
  output3dUrl: string | null;
  savedFilename: string | null;
  savedFilePath: string | null;
  thumbnailImage?: string | null; // Input image or prompt-based thumbnail for canvas display
  thumbnailImageRef?: string;    // External ref to thumbnail saved in generations/
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  inputSchema?: ModelInputDef[];
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  model3dHistory: Carousel3DItem[]; // Carousel history (IDs only)
  selectedModel3dHistoryIndex: number; // Currently selected 3D model in carousel
  lastGenerationCost?: number | null; // Cost of the last generation run
  // Camera settings for 3D viewer overlay
  sensorIndex?: number;      // Index into SENSOR_PRESETS (default 0 = Super 35mm)
  lensIndex?: number;        // Index into LENS_FOCAL_LENGTHS (default 5 = 35mm)
  aspectIndex?: number;      // Index into ASPECT_RATIO_PRESETS (default 2 = 16:9)
  showGrid?: boolean;        // 3D grid visibility (default false)
}

/**
 * Image → Gaussian Splat (SHARP) node.
 *
 * Takes an RGB image (from a normal image edge) plus a metric-depth EXR loaded
 * directly on the node (with channel selection) and produces a 3D Gaussian
 * Splat `.ply` via the local SHARP backend. The output flows over the `3d`
 * handle into the Gaussian Splat Viewer. The float depth never travels an
 * image edge — the backend reads it straight from the saved `.exr`.
 */
export type Image2GSDepthMethod = "sharp" | "exr_pixel" | "exr_grade";
export type Image2GSGradeSource = "percentile" | "region";
export type Image2GSGradeCurve = "affine" | "polynomial" | "histogram";

export interface Image2GSNodeData extends BaseNodeData {
  // RGB input (cached from the connected image edge for display / run)
  inputImages: string[];
  inputImageThumb?: string;
  // RGB loaded on the node (mirrors the depth EXR load). rgbSourcePath = display
  // filename (also names the output .ply); the image is saved to inputs/.
  rgbSourcePath?: string | null;
  rgbImageRef?: string;          // ref id of the RGB saved in inputs/
  rgbImagePath?: string;         // absolute path of the saved RGB
  rgbImageThumb?: string | null; // small preview (data URL)
  // Metric-depth EXR (loaded on the node — never travels an edge)
  depthExrRef?: string;          // ref id of the .exr saved in inputs/
  depthExrPath?: string;         // absolute path of the saved .exr
  depthExrFilename?: string;     // original filename for display
  depthChannels: string[];       // channel names found in the EXR header
  selectedDepthChannel: string | null;
  depthPreviewThumb?: string | null; // 8-bit grayscale preview (data URL)
  depthWidth?: number;
  depthHeight?: number;
  // Camera intrinsics → f_px = (focalLengthMm / apertureMm) * imageWidthPx
  focalLengthMm: number;
  apertureMm: number;            // horizontal film-back aperture (mm)
  fPxOverride?: number | null;   // optional explicit f_px override
  // camera.json loaded directly on the node (manual, not auto-derived).
  cameraJsonName?: string | null;       // camera_name, for display
  cameraJsonFocalRaw?: number | null;   // raw focal_length (before the ×2/3 option)
  focalTwoThirds?: boolean;             // multiply the camera.json focal by 2/3
  blendAlpha: number;            // 0=trust depth … 1=ignore depth; 0.4 default (exr_pixel only)
  // SHARP /generate depth pipeline (depth_method + grade_* + albedo AOV).
  depthMethod: Image2GSDepthMethod;   // "sharp" (no depth) | "exr_pixel" | "exr_grade"; default "exr_pixel"
  gradeSource: Image2GSGradeSource;   // exr_grade only; default "percentile"
  gradeCurve: Image2GSGradeCurve;     // exr_grade only; default "affine"
  gradeMinSlope: number;              // exr_grade only; floor on the grade-curve slope (0=off, 0.3–0.6 reduces 3DGS popping); >= 0
  // Albedo AOV loaded on the node — only for depth_method="exr_grade" + grade_source="region".
  albedoSourcePath?: string | null;   // display filename
  albedoImageRef?: string;            // ref id of the albedo saved in inputs/
  albedoImagePath?: string;           // absolute path of the saved albedo
  albedoImageThumb?: string | null;   // small preview (data URL)
  // 3D output (mirrors Generate3DNodeData)
  output3dUrl: string | null;    // blob: URL of the generated .ply
  savedFilename: string | null;
  savedFilePath: string | null;
  status: NodeStatus;
  error: string | null;
  model3dHistory: Carousel3DItem[];   // carousel history (ids only)
  selectedModel3dHistoryIndex: number;
  lastGenerationCost?: number | null;
}

/**
 * WorldLabs Panorama node - generates equirectangular panoramas via Marble API.
 * Quick preview step (defaults to Marble 0.1-mini for speed/cost).
 * Supports text, single-image, and multi-image prompts with azimuth control.
 */
export interface WorldLabsPanoNodeData extends BaseNodeData {
  worldName: string;
  model: "Marble 0.1-plus" | "Marble 0.1-mini";
  seed: number | null;
  inputImages: string[];
  inputPrompt: string | null;
  operationId: string | null;
  worldId: string | null;
  status: NodeStatus;
  error: string | null;
  progress: string | null;
  panoUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  /** Per-image azimuth angles for multi-image generation. Maps connection index → degrees. */
  imageAzimuths: Record<number, number>;
  parametersExpanded?: boolean; // Collapse state for inline parameter display
}

/**
 * WorldLabs World node - generates full 3D Gaussian Splat world from a 2:1 panorama.
 * Production quality step (defaults to Marble 0.1-plus).
 * Accepts a single panorama image input, outputs 3D SPZ data.
 */
export interface WorldLabsWorldNodeData extends BaseNodeData {
  worldName: string;
  model: "Marble 0.1-plus" | "Marble 0.1-mini";
  seed: number | null;
  isPano: boolean;
  inputImages: string[];
  inputPrompt: string | null;
  operationId: string | null;
  worldId: string | null;
  status: NodeStatus;
  error: string | null;
  progress: string | null;
  spzUrls: { full_res: string | null; "500k": string | null; "100k": string | null } | null;
  panoUrl: string | null;
  thumbnailUrl: string | null;
  marbleViewerUrl: string | null;
  caption: string | null;
  viewerWindowOpen: boolean;
  parametersExpanded?: boolean; // Collapse state for inline parameter display
}

/**
 * Carousel audio item for per-node audio history
 */
export interface CarouselAudioItem {
  id: string;
  timestamp: number;
  prompt: string;
  model: string; // Model ID for audio (not ModelType since external providers)
  // Settings snapshot for recall when browsing history
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
}

/**
 * Carousel 3D item for per-node 3D model history
 */
export interface Carousel3DItem {
  id: string;
  timestamp: number;
  prompt: string;
  model: string;
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  thumbnailId?: string; // ref to thumbnail image in generations folder
}

/**
 * Generate Audio node - AI audio/TTS generation
 */
export interface GenerateAudioNodeData extends BaseNodeData {
  inputPrompt: string | null;
  outputAudio: string | null; // Audio data URL
  outputAudioRef?: string; // External audio reference for storage optimization
  selectedModel?: SelectedModel; // Required for audio generation
  parameters?: Record<string, unknown>; // Model-specific parameters (voice, speed, etc.)
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  audioHistory: CarouselAudioItem[]; // Carousel history (IDs only)
  selectedAudioHistoryIndex: number; // Currently selected audio in carousel
  duration: number | null; // Duration in seconds
  format: string | null; // MIME type (audio/mp3, audio/wav, etc.)
  lastGenerationCost?: number | null; // Cost of the last generation run
}

/**
 * LLM Generate node - AI text generation
 */
export interface LLMGenerateNodeData extends BaseNodeData {
  inputPrompt: string | null;
  inputImages: string[];
  inputImageRefs?: string[]; // External image references for storage optimization
  outputText: string | null;
  provider: LLMProvider;
  model: LLMModelType;
  temperature: number;
  maxTokens: number;
  /** Provider-agnostic reasoning / thinking effort.
   *    off    = no reasoning override (provider default; reasoning-era
   *             models still reason internally)
   *    low    = light reasoning (Anthropic 2k thinking tokens, OpenAI
   *             "low", Gemini 1k thinking budget)
   *    medium = balanced (Anthropic 8k, OpenAI "medium", Gemini dynamic)
   *    high   = deep (Anthropic 16k, OpenAI "high", Gemini 8k)
   *  Only sent to providers/models that support reasoning; hidden in the
   *  UI otherwise. Defaults to "off". */
  reasoning?: "off" | "low" | "medium" | "high";
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  lastGenerationCost?: number | null; // Cost of the last generation run

  // ─── Conversation mode (multi-turn chat) ───────────────────────
  /** When true, the node remembers turns and sends the full transcript
   *  on every run. Default false → one-shot like before. */
  conversationMode?: boolean;
  /** Optional system prompt prepended to every request as the provider's
   *  native system slot. Stored separately from `conversation` because
   *  all three providers carry it in a dedicated field. */
  systemPrompt?: string;
  /** Persistent multi-turn history. Each Run appends one user turn (with
   *  the current text/image inputs) and one assistant turn. Carries
   *  through workflow save/load. */
  conversation?: import("./api").ConversationTurn[];
  /** Cap the most recent N user+assistant turns sent on each request.
   *  0 / undefined = unlimited. Useful to control token spend. */
  maxHistoryTurns?: number;
}

/**
 * Output node - displays final workflow results
 */
export interface OutputNodeData extends BaseNodeData {
  image: string | null;
  imageRef?: string; // External image reference for storage optimization
  video?: string | null; // Video data URL or HTTP URL
  audio?: string | null; // Audio data URL or HTTP URL
  model3d?: string | null; // 3D model URL (GLB, SPZ, etc.)
  contentType?: "image" | "video" | "audio" | "3d"; // Explicit content type hint
  outputFilename?: string; // Custom filename for saved outputs (without extension)
  /** When true, "Output Now" saves only the media file — no sidecar workflow .json. */
  skipJsonSidecar?: boolean;
}

/**
 * Output Gallery node - displays scrollable thumbnail grid of images with lightbox
 */
export interface OutputGalleryNodeData extends BaseNodeData {
  images: string[]; // Array of base64 data URLs from connected nodes
}

/**
 * Image Compare node - side-by-side image comparison with draggable slider
 */
export interface ImageCompareNodeData extends BaseNodeData {
  imageA: string | null;
  imageB: string | null;
  // Externalized + lazy like other image nodes: full-res saved to /inputs as a
  // ref, a small inline thumb drives the preview, full-res loads on demand.
  imageARef?: string;
  imageBRef?: string;
  imageAThumb?: string;
  imageBThumb?: string;
  compareMode: "slide" | "blend" | "difference";
  blendOpacity: number;
}

/**
 * Video Compare node - side-by-side video comparison with slider, blend, and difference modes
 */
export interface VideoCompareNodeData extends BaseNodeData {
  videoA: string | null;
  videoB: string | null;
  compareMode: "slide" | "blend" | "difference";
  blendOpacity: number;
}

/**
 * Video stitch clip - represents a single video clip in the filmstrip
 */
export interface VideoStitchClip {
  edgeId: string;                // Edge ID for disconnect capability
  sourceNodeId: string;          // Source node producing this video
  thumbnail: string | null;      // Base64 JPEG thumbnail
  duration: number | null;       // Clip duration in seconds
  handleId: string;              // Which input handle (video-0, video-1, etc.)
}

/**
 * Video Stitch node - concatenates multiple videos into a single output
 */
export interface VideoStitchNodeData extends BaseNodeData {
  clips: VideoStitchClip[];       // Ordered clip sequence for filmstrip
  clipOrder: string[];            // Edge IDs in user-defined order (drag reorder)
  outputVideo: string | null;     // Stitched video blob URL or data URL
  loopCount: 1 | 2 | 3;          // How many times to repeat the clip sequence (1 = no loop)
  status: NodeStatus;
  error: string | null;
  progress: number;               // 0-100 processing progress
  encoderSupported: boolean | null; // null = not checked yet, true/false after check
}

/**
 * Ease Curve node - applies speed curve to video using easing functions
 */
export interface EaseCurveNodeData extends BaseNodeData {
  bezierHandles: [number, number, number, number];
  easingPreset: string | null;
  inheritedFrom: string | null;
  outputDuration: number;
  outputVideo: string | null;
  status: NodeStatus;
  error: string | null;
  progress: number;
  encoderSupported: boolean | null;
}

/**
 * Video Trim node - trims a video clip to a user-defined start/end time range
 */
export interface VideoTrimNodeData extends BaseNodeData {
  startTime: number;          // Trim start in seconds (default 0)
  endTime: number;            // Trim end in seconds (default 0 = full duration, set on video load)
  duration: number | null;    // Source video duration (populated when video loads metadata)
  outputVideo: string | null; // Trimmed video blob URL or data URL
  status: NodeStatus;
  error: string | null;
  progress: number;           // 0-100 processing progress
  encoderSupported: boolean | null;
}

/**
 * Video Frame Grab node - extracts the first or last frame from a video as a full-resolution PNG image
 */
export interface VideoFrameGrabNodeData extends BaseNodeData {
  framePosition: "first" | "last";   // Which frame to extract
  outputImage: string | null;        // Extracted frame as base64 PNG data URL
  status: NodeStatus;
  error: string | null;
}

/**
 * Router node - pure passthrough routing node with dynamic multi-type handles
 */
export interface RouterNodeData extends BaseNodeData {
  // No internal state - all routing is derived from edge connections
}

/**
 * Switch node - toggle-controlled routing with named outputs
 */
export interface SwitchNodeData extends BaseNodeData {
  inputType: HandleType | null;  // Derived from connected input edge, null when disconnected
  switches: Array<{
    id: string;        // Unique identifier for handle mapping
    name: string;      // User-editable label
    enabled: boolean;  // Toggle state
  }>;
}

/**
 * Match mode for conditional switch rules
 */
export type MatchMode = "exact" | "contains" | "starts-with" | "ends-with";

/**
 * Conditional switch rule for text-based routing
 */
export interface ConditionalSwitchRule {
  id: string;           // Unique handle ID, prefixed with "rule-" to avoid collision with reserved "default" keyword
  value: string;        // Comma-separated match values
  mode: MatchMode;      // Match strategy
  label: string;        // User-editable display name
  isMatched: boolean;   // Computed match state
}

/**
 * Conditional Switch node - text-based routing with multi-mode matching
 */
export interface ConditionalSwitchNodeData extends BaseNodeData {
  incomingText: string | null;  // Upstream text for evaluation and display
  rules: ConditionalSwitchRule[]; // User-defined rules
  evaluationPaused?: boolean;   // When true, skips rule evaluation and downstream dimming
}

/**
 * Split Grid node - splits image into grid cells for parallel processing
 */
export interface SplitGridNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string; // External image reference for storage optimization
  targetCount: number; // 4, 6, 8, 9, or 10
  defaultPrompt: string;
  generateSettings: {
    aspectRatio: AspectRatio;
    resolution: Resolution;
    model: ModelType;
    useGoogleSearch: boolean;
    useImageSearch: boolean;
  };
  childNodeIds: Array<{
    imageInput: string;
    prompt: string;
    nanoBanana: string;
  }>;
  gridRows: number;
  gridCols: number;
  isConfigured: boolean;
  status: NodeStatus;
  error: string | null;
}

/**
 * GLB 3D Viewer node - loads and displays 3D models, captures viewport as image
 */
export interface GLBViewerNodeData extends BaseNodeData {
  glbUrl: string | null;       // Object URL for the loaded GLB file
  glbFileRef?: string;         // External ref for the GLB file (persisted to disk)
  filename: string | null;     // Original filename for display
  capturedImage: string | null; // Base64 PNG snapshot of the 3D viewport
  capturedImageRef?: string;   // External ref for capturedImage
  thumbnailImage?: string | null; // Auto-generated thumbnail for canvas display
  thumbnailImageRef?: string;  // External ref for thumbnail
  // Camera settings for 3D viewer overlay
  sensorIndex?: number;      // Index into SENSOR_PRESETS (default 0 = Super 35mm)
  lensIndex?: number;        // Index into LENS_FOCAL_LENGTHS (default 5 = 35mm)
  aspectIndex?: number;      // Index into ASPECT_RATIO_PRESETS (default 2 = 16:9)
  showGrid?: boolean;        // 3D grid visibility (default false)
}

/**
 * SPZ/PLY Viewer node - opens external 3D Gaussian Splat viewer, captures screenshots
 */
export interface SpzViewerNodeData extends BaseNodeData {
  spzUrl: string | null;         // SPZ/PLY file URL (HTTP or blob)
  filename: string | null;       // Display name
  capturedImage: string | null;  // Latest captured screenshot from viewer
  capturedImageRef?: string;     // External ref for capturedImage
  capturedDepthImage: string | null; // Depth map from latest capture (grayscale)
  viewerState?: object | null;   // Full viewer state (meshes, lights, IBL, camera, splat transform)
  capturedDepthImageRef?: string; // External ref for capturedDepthImage
  viewerOpen: boolean;           // Whether the viewer window is currently open
  // camera.json loaded directly on the node → seeds the viewer's Lens/Sensor.
  cameraJsonName?: string | null;
  cameraJsonFocal?: number | null;     // focal_length (mm) → viewer Lens
  cameraJsonAperture?: number | null;  // aperture (mm) → viewer Sensor
}

/**
 * Panorama Viewer node - views equirectangular panoramas with crop rectangle,
 * captures perspective snapshots with camera metadata.
 */
export interface PanoViewerNodeData extends BaseNodeData {
  panoUrl: string | null;          // Equirectangular image URL
  viewerOpen: boolean;             // Whether the viewer window is currently open
}

/**
 * Panorama Crop node - holds a perspective snapshot extracted from a panorama
 * with its camera metadata. Created automatically by PanoViewer on capture.
 */
export interface PanoCropNodeData extends BaseNodeData {
  image: string | null;            // Perspective snapshot (base64)
  imageRef?: string;               // External ref for externalized crop image
  metadata: string | null;         // JSON-serialized PanoCropMetadata
  filename: string | null;
  dimensions: { width: number; height: number } | null;
}

/**
 * Panorama Editor node - composites an edited perspective image back onto
 * an equirectangular panorama using camera metadata for reprojection.
 */
export interface PanoEditorNodeData extends BaseNodeData {
  outputImage: string | null;      // Composited equirectangular (base64)
  status: NodeStatus;
  error: string | null;
}

/**
 * Union of all node data types
 */
export type WorkflowNodeData =
  | ImageInputNodeData
  | AudioInputNodeData
  | AnnotationNodeData
  | PromptNodeData
  | ArrayNodeData
  | PromptConstructorNodeData
  | NanoBananaNodeData
  | GenerateVideoNodeData
  | Generate3DNodeData
  | Image2GSNodeData
  | WorldLabsPanoNodeData
  | WorldLabsWorldNodeData
  | GenerateAudioNodeData
  | LLMGenerateNodeData
  | SplitGridNodeData
  | OutputNodeData
  | OutputGalleryNodeData
  | ImageCompareNodeData
  | VideoCompareNodeData
  | VideoStitchNodeData
  | EaseCurveNodeData
  | VideoTrimNodeData
  | VideoFrameGrabNodeData
  | RouterNodeData
  | SwitchNodeData
  | ConditionalSwitchNodeData
  | GLBViewerNodeData
  | SpzViewerNodeData
  | PanoCropNodeData
  | PanoViewerNodeData
  | PanoEditorNodeData
  | MaskPainterNodeData
  | RotoNodeData
  | CompNodeData
  | VideoInputNodeData
  | ImageCropNodeData
  | MirrorNodeData
  | ReformatNodeData
  | CubemapEquirectNodeData
  | CubemapFacesNodeData
  | ColorGradeNodeData
  | HsvCorrectNodeData
  | ContrastAdjustNodeData
  | PanoShiftNodeData;

/**
 * Workflow node with typed data (extended with optional groupId)
 */
export type WorkflowNode = Node<WorkflowNodeData, NodeType> & {
  groupId?: string;
};

/**
 * Handle types for node connections
 */
export type HandleType = "image" | "text" | "audio" | "video" | "3d" | "easeCurve";

/**
 * Default settings for node types - stored in localStorage
 */
export interface GenerateImageNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
  aspectRatio?: string;
  resolution?: string;
  useGoogleSearch?: boolean;
  useImageSearch?: boolean;
}

export interface GenerateVideoNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
}

export interface Generate3DNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
}

export interface GenerateAudioNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
}

export interface LLMNodeDefaults {
  provider?: LLMProvider;
  model?: LLMModelType;
  temperature?: number;
  maxTokens?: number;
  reasoning?: "off" | "low" | "medium" | "high";
}

export interface NodeDefaultsConfig {
  generateImage?: GenerateImageNodeDefaults;
  generateVideo?: GenerateVideoNodeDefaults;
  generate3d?: Generate3DNodeDefaults;
  generateAudio?: GenerateAudioNodeDefaults;
  llm?: LLMNodeDefaults;
}
