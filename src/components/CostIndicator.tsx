"use client";

import { useState, useMemo } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { calculatePredictedCost, formatCost } from "@/utils/costCalculator";
import { CostDialog } from "./CostDialog";

export function CostIndicator() {
  const [showDialog, setShowDialog] = useState(false);
  const nodes = useWorkflowStore((state) => state.nodes);
  const incurredCost = useWorkflowStore((state) => state.incurredCost);

  const predictedCost = useMemo(() => {
    return calculatePredictedCost(nodes);
  }, [nodes]);

  const hasAnyNodes = predictedCost.nodeCount > 0;

  // Hide if there are no generation nodes and no costs incurred
  if (!hasAnyNodes && incurredCost === 0) {
    return null;
  }

  // Always show estimated cost when generation nodes exist
  // Show incurred cost alongside if any generations have run
  let displayCost: string;
  let costTitle: string;

  if (incurredCost > 0 && predictedCost.totalCost > 0) {
    // Both estimated and actual: show both
    displayCost = `Est. ~${formatCost(predictedCost.totalCost)} / ${formatCost(incurredCost)} spent`;
    costTitle = "Estimated workflow cost & session spend (click for details)";
  } else if (incurredCost > 0) {
    // Only actual cost (no estimated pricing available)
    displayCost = `${formatCost(incurredCost)} spent`;
    costTitle = "Session spend (click for details)";
  } else if (predictedCost.totalCost > 0) {
    // Only estimated cost (no generations run yet)
    displayCost = `Est. ~${formatCost(predictedCost.totalCost)}`;
    costTitle = "Estimated workflow cost (click for details)";
  } else if (hasAnyNodes && predictedCost.unknownPricingCount > 0) {
    // Has generation nodes but no pricing data available
    displayCost = "Cost TBD";
    costTitle = "Some models have unknown pricing (click for details)";
  } else {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        className="px-2 py-0.5 rounded text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
        title={costTitle}
      >
        {displayCost}
      </button>

      {showDialog && (
        <CostDialog
          predictedCost={predictedCost}
          incurredCost={incurredCost}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}
