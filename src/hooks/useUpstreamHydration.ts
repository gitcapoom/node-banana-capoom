"use client";

import { useEffect, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

/**
 * The two halves of the "connected but not hydrated yet" guard, shared by every
 * node that consumes an upstream image.
 *
 * WHY A SHARED HOOK. Displayed image fields are lazily hydrated
 * (THUMB_DISPLAY_FIELDS in imageFieldMap): on open they are null, the producing
 * node paints its thumb — so it looks perfectly loaded — and the full-res sits
 * on disk behind a ref. `getSourceOutput` returns that null, so EVERY consumer
 * sees the same ambiguity: "nothing is wired" and "the wire's value has not
 * loaded" are the same value. A consumer that guesses wrong either sits empty
 * forever or clears a good saved output on open. That question is identical for
 * all of them, so it is answered once, here.
 *
 * WHAT IS DELIBERATELY *NOT* SHARED. How a node RESOLVES its input value stays
 * per-node, because the mechanisms are not interchangeable:
 * `getConnectedInputsPure` resolves through `dot` / `router` / `switch` reroute
 * nodes, while `useUpstreamImage` (React Flow's indexes) reads the direct source
 * only. Swapping one for the other would silently break reroutes or regress
 * per-store-write cost. So callers keep their resolver and pass in the wiring
 * key they already have.
 */

/**
 * Identifies this node's incoming wiring: every incoming edge's source +
 * handle, or "" when nothing is wired.
 *
 * O(edges) with no node lookup — deliberately not the O(edges + nodes) scan
 * `useUpstreamImage` warns about, which is expensive because of the `nodes.find`
 * inside it. Nodes that already hold a React Flow-indexed upstream should pass
 * its `sourceId` to `useHydrateUnresolvedInputs` instead of calling this.
 */
export function useIncomingEdgeKey(nodeId: string, targetHandle?: string): string {
  return useWorkflowStore((s) =>
    s.edges
      .filter((e) => e.target === nodeId && (targetHandle === undefined || e.targetHandle === targetHandle))
      .map((e) => `${e.source}|${e.sourceHandle}|${e.targetHandle}`)
      .join(","));
}

/**
 * Ask for this node's immediate inputs to be hydrated, ONCE per wiring, while
 * an edge exists whose value has not arrived.
 *
 * `wiringKey` is any string that changes when the wiring changes and is empty
 * when nothing is connected (`useIncomingEdgeKey`, or an upstream node id).
 * `resolved` is the node's own answer to "do I have the value I need".
 *
 * Ref-guarded rather than effect-dep-guarded so a load that FAILS does not
 * become a request loop across re-renders; the guard is released again once the
 * value arrives, so a value that later disappears re-requests.
 */
export function useHydrateUnresolvedInputs(
  nodeId: string,
  wiringKey: string,
  resolved: boolean,
): void {
  const loadNodeFullResInputs = useWorkflowStore((s) => s.loadNodeFullResInputs);
  const requestedRef = useRef<string>("");

  useEffect(() => {
    if (!wiringKey || resolved) {
      requestedRef.current = "";
      return;
    }
    if (requestedRef.current === wiringKey) return;
    requestedRef.current = wiringKey;
    void loadNodeFullResInputs(nodeId);
  }, [nodeId, wiringKey, resolved, loadNodeFullResInputs]);
}
