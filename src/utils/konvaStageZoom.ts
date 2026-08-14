import type Konva from "konva";

/** Resulting stage view after a zoom step. */
export interface StageView {
  scale: number;
  position: { x: number; y: number };
}

export interface ZoomOptions {
  min?: number;
  max?: number;
  /** Multiplier per wheel notch. */
  by?: number;
}

/**
 * Cursor-anchored wheel zoom for a Konva stage.
 *
 * Scaling a stage without also moving it zooms toward the stage ORIGIN, so the
 * pixel under the pointer drifts away as you scroll — the image appears to
 * slide out from under the cursor. Anchoring means solving for the position
 * that keeps the image point beneath the pointer fixed:
 *
 *   imagePoint = (pointer - stagePos) / scale     (constant across the zoom)
 *   stagePos'  = pointer - imagePoint * scale'
 *
 * Returns null when there's no pointer or the scale is already clamped, so
 * callers can skip the state update entirely.
 */
export function zoomStageAtPointer(
  stage: Konva.Stage,
  deltaY: number,
  { min = 0.1, max = 8, by = 1.1 }: ZoomOptions = {},
): StageView | null {
  const pointer = stage.getPointerPosition();
  if (!pointer) return null;

  const oldScale = stage.scaleX();
  const newScale = Math.min(max, Math.max(min, deltaY > 0 ? oldScale / by : oldScale * by));
  if (newScale === oldScale) return null;

  const imageX = (pointer.x - stage.x()) / oldScale;
  const imageY = (pointer.y - stage.y()) / oldScale;

  return {
    scale: newScale,
    position: {
      x: pointer.x - imageX * newScale,
      y: pointer.y - imageY * newScale,
    },
  };
}
