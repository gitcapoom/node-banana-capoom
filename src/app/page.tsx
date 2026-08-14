"use client";

import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Header } from "@/components/Header";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";
import { FloatingActionBar } from "@/components/FloatingActionBar";
import { AnnotationModal } from "@/components/AnnotationModal";
import { MaskPainterModal } from "@/components/MaskPainterModal";
import { RotoModal } from "@/components/RotoModal";
import { CompModal } from "@/components/CompModal";
import { NodeMediaViewer } from "@/components/NodeMediaViewer";
import { useWorkflowStore } from "@/store/workflowStore";
import { openWorkflowByPath } from "@/utils/openWorkflowByPath";
import { useToast } from "@/components/Toast";

export default function Home() {
  const initializeAutoSave = useWorkflowStore(
    (state) => state.initializeAutoSave
  );
  const cleanupAutoSave = useWorkflowStore((state) => state.cleanupAutoSave);

  useEffect(() => {
    initializeAutoSave();
    return () => cleanupAutoSave();
  }, [initializeAutoSave, cleanupAutoSave]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useWorkflowStore.getState().hasUnsavedChanges) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Deep-link: open a project directly from a `?project=<absolute path>` URL,
  // e.g. http://host:3000/?project=//OTOSERVE10/Projects/AD/.../AI_Gen/AI_Gen.json
  // Runs once on first load; the param is left in place so the link stays
  // bookmarkable.
  useEffect(() => {
    const project = new URLSearchParams(window.location.search).get("project");
    if (!project) return;
    openWorkflowByPath(project).then((r) => {
      if (!r.ok) {
        useToast.getState().show(
          "Couldn't open project from URL",
          "error",
          true,
          `${r.error || "Unknown error"}\n${project}`
        );
      }
    });
  }, []);

  return (
    <ReactFlowProvider>
      <div className="h-screen flex flex-col">
        <Header />
        <WorkflowCanvas />
        <FloatingActionBar />
        <AnnotationModal />
        <MaskPainterModal />
        <RotoModal />
        <CompModal />
        <NodeMediaViewer />
      </div>
    </ReactFlowProvider>
  );
}
