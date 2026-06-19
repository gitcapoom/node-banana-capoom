import { NodeType } from "@/types";

export interface NodeCatalogEntry {
  type: NodeType;
  label: string;
}

export interface NodeCatalogCategory {
  label: string;
  nodes: NodeCatalogEntry[];
}

// Canonical list of all addable nodes, grouped by category.
// Single source of truth shared by the bottom "All nodes" menu
// (FloatingActionBar) and the Tab / edge-drop node search palette.
export const ALL_NODES_CATEGORIES: NodeCatalogCategory[] = [
  {
    label: "Input",
    nodes: [
      { type: "imageInput", label: "Image Input" },
      { type: "videoInput", label: "Video Input" },
      { type: "audioInput", label: "Audio Input" },
    ],
  },
  {
    label: "Text",
    nodes: [
      { type: "prompt", label: "Prompt" },
      { type: "promptConstructor", label: "Prompt Constructor" },
      { type: "array", label: "Array" },
    ],
  },
  {
    label: "Generate",
    nodes: [
      { type: "nanoBanana", label: "Generate Image" },
      { type: "upscaleGrid", label: "Upscale (Grid)" },
      { type: "generateVideo", label: "Generate Video" },
      { type: "generate3d", label: "Generate 3D" },
      { type: "image2GS", label: "Image to Splat" },
      { type: "generateAudio", label: "Generate Audio" },
      { type: "llmGenerate", label: "LLM Generate" },
      { type: "worldLabsPano", label: "Generate Panorama" },
      { type: "worldLabsWorld", label: "Generate World" },
    ],
  },
  {
    label: "Process",
    nodes: [
      { type: "annotation", label: "Annotate" },
      { type: "panoEditor", label: "Pano Edit" },
      { type: "maskPainter", label: "Mask Paint" },
      { type: "roto", label: "Roto" },
      { type: "comp", label: "Composite" },
      { type: "imageCrop", label: "Image Crop" },
      { type: "mirror", label: "Mirror" },
      { type: "reformat", label: "Reformat" },
      { type: "cubemapEquirect", label: "Cube ⇄ Pano" },
      { type: "cubemapFaces", label: "Cube ⇄ Faces" },
      { type: "panoShift", label: "Pano Shift" },
      { type: "colorGrade", label: "Color Grade" },
      { type: "hsvCorrect", label: "HSV Color Correct" },
      { type: "contrastAdjust", label: "Contrast Adjust" },
      { type: "splitGrid", label: "Split Grid" },
      { type: "videoStitch", label: "Video Stitch" },
      { type: "videoTrim", label: "Video Trim" },
      { type: "easeCurve", label: "Ease Curve" },
      { type: "videoFrameGrab", label: "Frame Grab" },
      { type: "imageCompare", label: "Image Compare" },
      { type: "videoCompare", label: "Video Compare" },
    ],
  },
  {
    label: "Route",
    nodes: [
      { type: "router", label: "Router" },
      { type: "switch", label: "Switch" },
      { type: "conditionalSwitch", label: "Conditional Switch" },
    ],
  },
  {
    label: "Output",
    nodes: [
      { type: "output", label: "Output" },
      { type: "outputGallery", label: "Output Gallery" },
    ],
  },
  {
    label: "View",
    nodes: [
      { type: "glbViewer", label: "3D Viewer" },
      { type: "spzViewer", label: "Gaussian Splat Viewer" },
      { type: "panoViewer", label: "Pano Viewer" },
    ],
  },
];
