/**
 * WaveSpeed static fallback schemas.
 *
 * Used only when the dynamic api_schema isn't available (offline, no API key,
 * model not returned by the list endpoint). These are fuzzier than the OpenAPI
 * path since we infer the shape from the model ID alone.
 */

import type { ExtractedResult } from "../types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";

export function getWaveSpeedStaticSchema(modelId: string): ExtractedResult {
  const modelIdLower = modelId.toLowerCase();

  const imageParams: ModelParameter[] = [
    {
      name: "num_inference_steps",
      type: "integer",
      description: "Number of denoising steps. More steps usually lead to higher quality but slower generation.",
      default: 28,
      minimum: 1,
      maximum: 100,
    },
    {
      name: "guidance_scale",
      type: "number",
      description: "Guidance scale for classifier-free guidance. Higher values follow the prompt more closely.",
      default: 3.5,
      minimum: 0,
      maximum: 20,
    },
    {
      name: "seed",
      type: "integer",
      description: "Random seed for reproducibility. Use -1 for random.",
      default: -1,
    },
    {
      name: "image_size",
      type: "string",
      description: "Output image dimensions",
      default: "1024x1024",
      enum: ["512x512", "768x768", "1024x1024", "1024x576", "576x1024", "1024x768", "768x1024", "1280x720", "720x1280"],
    },
  ];

  const imageInputs: ModelInput[] = [];

  const videoParams: ModelParameter[] = [
    { name: "num_frames", type: "integer", description: "Number of frames to generate", default: 81, minimum: 16, maximum: 256 },
    { name: "fps", type: "integer", description: "Frames per second for the output video", default: 16, minimum: 8, maximum: 30 },
    { name: "seed", type: "integer", description: "Random seed for reproducibility. Use -1 for random.", default: -1 },
    { name: "resolution", type: "string", description: "Output video resolution", default: "480p", enum: ["480p", "720p", "1080p"] },
  ];

  const isVideoModel =
    modelIdLower.includes("wan") ||
    modelIdLower.includes("video") ||
    modelIdLower.includes("kling") ||
    modelIdLower.includes("luma") ||
    modelIdLower.includes("minimax") ||
    modelIdLower.includes("t2v") ||
    modelIdLower.includes("i2v");

  const isImg2ImgModel =
    modelIdLower.includes("kontext") ||
    modelIdLower.includes("img2img") ||
    modelIdLower.includes("edit") ||
    modelIdLower.includes("inpaint") ||
    modelIdLower.includes("controlnet");

  if (isVideoModel) {
    if (modelIdLower.includes("i2v")) {
      imageInputs.push({
        name: "image",
        type: "image",
        required: true,
        label: "Input Image",
        description: "Starting image for video generation",
      });
    }
    return {
      parameters: videoParams,
      inputs: imageInputs,
      health: {
        status: "heuristic-fallback",
        warnings: [`static-fallback: inferred video schema from model id "${modelId}"`],
        extractedAt: Date.now(),
      },
    };
  }

  if (isImg2ImgModel) {
    imageInputs.push({
      name: "images",
      type: "image",
      required: true,
      label: "Input Image",
      description: "Image to transform or edit",
      isArray: true,
    });
    imageParams.push({
      name: "strength",
      type: "number",
      description: "How much to transform the input image. 0 = no change, 1 = ignore input completely.",
      default: 0.8,
      minimum: 0,
      maximum: 1,
    });
  }

  return {
    parameters: imageParams,
    inputs: imageInputs,
    health: {
      status: "heuristic-fallback",
      warnings: [`static-fallback: inferred image schema from model id "${modelId}"`],
      extractedAt: Date.now(),
    },
  };
}
