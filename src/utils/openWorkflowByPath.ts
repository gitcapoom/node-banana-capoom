import { useWorkflowStore, WorkflowFile, generateWorkflowId } from "@/store/workflowStore";

/**
 * Open a project/workflow from an absolute file path.
 *
 * Reads the JSON server-side via `PUT /api/workflow` (handles UNC paths),
 * loads it into the store, and configures the project (directory, name, id) —
 * the same flow the Header "Open" dialog uses. Shared by that dialog and the
 * `?project=<absolute path>` deep-link in app/page.tsx.
 *
 * Returns `{ ok, error? }`; callers decide how to surface failures.
 */
export async function openWorkflowByPath(
  filePath: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("/api/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
    const result = await response.json();

    if (!result.success) {
      return { ok: false, error: result.error || "Failed to open workflow" };
    }

    const workflow = result.workflow as WorkflowFile;
    if (!workflow.version || !workflow.nodes || !workflow.edges) {
      return { ok: false, error: "Invalid workflow file format" };
    }

    const store = useWorkflowStore.getState();

    // Embedded sidecar workflows get imported into the current workflow.
    if (workflow.embedded) {
      store.importWorkflow(workflow);
      return { ok: true };
    }

    // Regular workflows replace the current workflow.
    await store.loadWorkflow(workflow, result.directoryPath);
    const id = workflow.id || generateWorkflowId();
    const name = workflow.name || result.fileName;
    store.setWorkflowMetadata(id, name, result.directoryPath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to open workflow",
    };
  }
}
