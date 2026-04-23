/**
 * Gemini (native Veo) static schemas.
 *
 * Gemini image models don't expose parameters beyond prompt/image, so there's
 * no need for static schemas there. Only video (Veo 3.1 variants) is mapped.
 */

import type { ExtractedResult } from "../types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";

const commonParams: ModelParameter[] = [
  { name: "aspectRatio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
  { name: "durationSeconds", type: "string", description: "Video duration in seconds", enum: ["4", "6", "8"], default: "8" },
  { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p", "4k"], default: "720p" },
  { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
];

const textInputs: ModelInput[] = [
  { name: "prompt", type: "text", required: true, label: "Prompt" },
  { name: "negative_prompt", type: "text", required: false, label: "Neg. Prompt" },
];

type Raw = { parameters: ModelParameter[]; inputs: ModelInput[] };

const SCHEMAS: Record<string, Raw> = {
  "veo-3.1/text-to-video": { parameters: commonParams, inputs: textInputs },
  "veo-3.1/image-to-video": {
    parameters: commonParams,
    inputs: [...textInputs, { name: "image", type: "image", required: true, label: "Image" }],
  },
  "veo-3.1-fast/text-to-video": { parameters: commonParams, inputs: textInputs },
  "veo-3.1-fast/image-to-video": {
    parameters: commonParams,
    inputs: [...textInputs, { name: "image", type: "image", required: true, label: "Image" }],
  },
};

/**
 * Return the Gemini-side schema for a model, or null if not mapped (e.g. image models).
 */
export function getGeminiStaticSchema(modelId: string): ExtractedResult | null {
  const raw = SCHEMAS[modelId];
  if (!raw) return null;
  return {
    parameters: raw.parameters,
    inputs: raw.inputs,
    health: {
      status: "clean",
      warnings: [],
      extractedAt: Date.now(),
    },
  };
}
