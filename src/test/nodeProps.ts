/**
 * Shared test helper for building React Flow v12 `NodeProps` objects.
 *
 * React Flow v12 marks `type`, `dragging`, `zIndex`, `selectable`, `deletable`,
 * `selected`, and `draggable` as required on `NodeProps`, plus `isConnectable`,
 * `positionAbsoluteX`, and `positionAbsoluteY`. Component tests only care about
 * `id`, `type`, `data`, and `selected`, so this helper fills in the rest.
 *
 * Note: this file intentionally does not match the vitest include glob
 * (`src/**\/*.{test,spec}.{ts,tsx}`) so it is never collected as a test file.
 */

export const nodePropsDefaults = {
  draggable: true,
  dragging: false,
  selectable: true,
  deletable: true,
  zIndex: 0,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

type NodePropsDefaults = typeof nodePropsDefaults;

/**
 * Merge per-test node props (id, type, data, selected, ...) with the required
 * React Flow v12 `NodeProps` fields that tests don't care about.
 */
export function makeNodeProps<T extends { id: string; type: string; data: unknown }>(
  props: T
): T & NodePropsDefaults {
  return { ...nodePropsDefaults, ...props } as T & NodePropsDefaults;
}
