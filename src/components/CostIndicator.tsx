"use client";

import { useState, useMemo } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { calculatePredictedCost, formatCost, hasNonGeminiProviders } from "@/utils/costCalculator";
import { CostDialog } from "./CostDialog";

export function CostIndicator() {
  const [showDialog, setShowDialog] = useState(false);
  const nodes = useWorkflowStore((state) => state.nodes);
  const incurredCost = useWorkflowStore((state) => state.incurredCost);

  const predictedCost = useMemo(() => {
    return calculatePredictedCost(nodes);
  }, [nodes]);

  const nonGemini = useMemo(() => hasNonGeminiProviders(nodes), [nodes]);
  const hasAnyNodes = predictedCost.nodeCount > 0;

  // Hide if there are no nodes and no costs incurred
  if (!hasAnyNodes && incurredCost === 0) {
    return null;
  }

  // For non-Gemini workflows, show incurred (actual) cost instead of predicted
  let displayCost: string;
  let costTitle: string;

  if (nonGemini) {
    if (incurredCost === 0) return null;
    displayCost = formatCost(incurredCost);
    costTitle = "Session spend (click for details)";
  } else {
    displayCost = formatCost(predictedCost.totalCost);
    costTitle = "View cost details";
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
