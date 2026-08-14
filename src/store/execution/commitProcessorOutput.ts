import { createImageThumbnailWithMeta, thumbMaxDim } from "@/utils/createImageThumbnail";
import { cheapUrlKey } from "@/utils/renderSignature";
import type { WorkflowNodeData } from "@/types";

/**
 * Publish a local processor's output image, with the display thumb beside it.
 *
 * Every processor used to write `{ outputImage, outputImageRef: undefined }`
 * and nothing else, which left the node with only a full-res image to paint
 * into a ~60px preview — a 24MP frame re-decoded on every viewport remount.
 * The ref is still cleared, because these are freshly computed pixels that no
 * longer match anything on disk; the thumb generated here is what the preview
 * shows until the workflow next saves.
 *
 * Thumbnail failure is not an execution failure: the output is written first
 * and the thumb is a best-effort addition, so a processor never breaks because
 * a canvas encode did.
 */
export async function commitProcessorOutput(
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void,
  nodeId: string,
  outputImage: string | null,
  extra?: Partial<WorkflowNodeData>,
): Promise<void> {
  updateNodeData(nodeId, {
    outputImage,
    outputImageRef: undefined,
    // Drop the previous output's thumb key immediately. Until the new thumb
    // lands below, nothing may claim the old thumb matches these pixels.
    outputImageThumbKey: null,
    ...extra,
  } as Partial<WorkflowNodeData>);

  if (!outputImage) return;

  // Detached on purpose. The thumbnail is a display convenience, and awaiting it
  // would put a full-res decode + encode on the critical path of every run —
  // the executor would sit waiting on a canvas before the next node could
  // start. It lands a moment later and the preview swaps to it then.
  void (async () => {
    try {
      const t = await createImageThumbnailWithMeta(outputImage, thumbMaxDim(), 0.72, "jpeg");
      updateNodeData(nodeId, {
        outputImageThumb: t.thumb,
        // Keyed to the output it was made from, so the preview can trust it
        // even though the ref is (correctly) cleared above.
        outputImageThumbKey: cheapUrlKey(outputImage),
        outputImageDims: { width: t.width, height: t.height },
      } as Partial<WorkflowNodeData>);
    } catch {
      /* preview falls back to full-res, exactly as before */
    }
  })();
}
