/**
 * Color-wheel ↔ grade-channel mapping for the Color Grade node.
 *
 * A grading color wheel controls colour *balance* (a hue/saturation
 * offset from neutral) on top of a master *level*. We decompose a
 * per-channel GradeChannelValue {r,g,b} into:
 *   - level   = mean(r,g,b)               (the row's master slider)
 *   - balance = (r,g,b) - level           (zero-sum colour offset)
 * and map the balance to / from a 2D point on the unit disk using a
 * barycentric RGB layout — R, G, B primaries spaced 120° apart with R
 * at the top. This is exactly invertible, so dragging the wheel and
 * typing channel values stay in sync.
 *
 * `strength` scales disk radius → channel offset. Pass the row's range
 * so a full-radius drag is a sensible fraction of that range.
 */

import type { GradeChannelValue } from "./colorGrade";

// Primary directions on the disk. R at top (−90°), then G, B at +120°.
// y is "up positive" here; the component converts to CSS (y-down).
const ANG = {
  r: -Math.PI / 2,
  g: -Math.PI / 2 + (2 * Math.PI) / 3,
  b: -Math.PI / 2 + (4 * Math.PI) / 3,
};

export interface WheelPoint { x: number; y: number; } // unit disk, y up

/** Mean of the three channels — the master "level". */
export function channelLevel(v: GradeChannelValue): number {
  return (v.r + v.g + v.b) / 3;
}

/**
 * Convert a wheel point (unit disk) + master level into a channel value.
 * Each channel = level + projection of the point onto that primary's
 * direction, scaled by `strength`. The three projections sum to zero, so
 * the level is preserved (pure colour balance).
 */
export function wheelToChannel(pt: WheelPoint, level: number, strength: number): GradeChannelValue {
  const oR = (pt.x * Math.cos(ANG.r) + pt.y * Math.sin(ANG.r)) * strength;
  const oG = (pt.x * Math.cos(ANG.g) + pt.y * Math.sin(ANG.g)) * strength;
  const oB = (pt.x * Math.cos(ANG.b) + pt.y * Math.sin(ANG.b)) * strength;
  return { r: level + oR, g: level + oG, b: level + oB };
}

/**
 * Inverse: recover the wheel point from a channel value. Uses the
 * standard inverse of three 120°-spaced projections (factor 2/3).
 */
export function channelToWheel(v: GradeChannelValue, strength: number): WheelPoint {
  if (strength <= 0) return { x: 0, y: 0 };
  const level = channelLevel(v);
  const oR = v.r - level;
  const oG = v.g - level;
  const oB = v.b - level;
  const x = (2 / 3) * (oR * Math.cos(ANG.r) + oG * Math.cos(ANG.g) + oB * Math.cos(ANG.b)) / strength;
  const y = (2 / 3) * (oR * Math.sin(ANG.r) + oG * Math.sin(ANG.g) + oB * Math.sin(ANG.b)) / strength;
  // Clamp into the unit disk for display stability.
  const len = Math.hypot(x, y);
  if (len > 1) return { x: x / len, y: y / len };
  return { x, y };
}
