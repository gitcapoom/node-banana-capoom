"use client";

import { useState, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { TemplateExplorerView } from "./TemplateExplorerView";
import { PromptWorkflowView } from "./PromptWorkflowView";
import { FileOpenDialog } from "../FileOpenDialog";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile, directoryPath?: string, fileName?: string) => void;
  onClose: () => void;
  onNewProject: () => void;
}

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
  onNewProject,
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>("initial");
  const [showFileOpen, setShowFileOpen] = useState(false);

  const handleNewProject = useCallback(() => {
    onNewProject();
  }, [onNewProject]);

  const handleSelectTemplates = useCallback(() => {
    setCurrentView("templates");
  }, []);

  const handleSelectVibe = useCallback(() => {
    setCurrentView("vibe");
  }, []);

  const handleSelectLoad = useCallback(() => {
    setShowFileOpen(true);
  }, []);

  const handleFileOpenSelected = useCallback(async (filePath: string) => {
    setShowFileOpen(false);

    try {
      // Read the workflow file server-side (gives us the full path + directory)
      const response = await fetch("/api/workflow", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
      const result = await response.json();

      if (!result.success) {
        alert(`Failed to open: ${result.error}`);
        return;
      }

      const workflow = result.workflow as WorkflowFile;
      if (!workflow.version || !workflow.nodes || !workflow.edges) {
        alert("Invalid workflow file format");
        return;
      }

      // Pass the workflow — the parent handler will detect embedded vs regular
      onWorkflowGenerated(workflow, result.directoryPath, result.fileName);
    } catch (error) {
      alert(`Failed to open workflow: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, [onWorkflowGenerated]);

  const handleBack = useCallback(() => {
    setCurrentView("initial");
  }, []);

  const handleWorkflowSelected = useCallback(
    (workflow: WorkflowFile) => {
      onWorkflowGenerated(workflow);
    },
    [onWorkflowGenerated]
  );

  // Template explorer needs more width for two-column layout
  const dialogWidth = currentView === "templates" ? "max-w-6xl" : "max-w-2xl";
  const dialogHeight = currentView === "templates" ? "max-h-[85vh]" : "max-h-[80vh]";

  return (
    <>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onWheelCapture={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        <div className={`w-full ${dialogWidth} mx-4 bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl overflow-clip ${dialogHeight} flex flex-col`} onClick={(e) => e.stopPropagation()}>
          {currentView === "initial" && (
            <QuickstartInitialView
              onNewProject={handleNewProject}
              onSelectTemplates={handleSelectTemplates}
              onSelectVibe={handleSelectVibe}
              onSelectLoad={handleSelectLoad}
            />
          )}
          {currentView === "templates" && (
            <TemplateExplorerView
              onBack={handleBack}
              onWorkflowSelected={handleWorkflowSelected}
            />
          )}
          {currentView === "vibe" && (
            <PromptWorkflowView
              onBack={handleBack}
              onWorkflowGenerated={handleWorkflowSelected}
            />
          )}
        </div>
      </div>

      {showFileOpen && (
        <FileOpenDialog
          onFileSelected={handleFileOpenSelected}
          onCancel={() => setShowFileOpen(false)}
        />
      )}
    </>
  );
}
