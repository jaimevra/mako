/**
 * Delete a workflow after asking: its folder leaves main in one commit and
 * the worker is deployed without it. Answers the refusal, null when it was
 * deleted or the person cancelled.
 */
import { useCallback } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import { useWorkflowsStore } from "../store/workflowsStore";

export function useDeleteWorkflow(workspaceId: string | undefined) {
  const confirm = useConfirm();
  const deleteWorkflow = useWorkflowsStore(s => s.deleteWorkflow);
  return useCallback(
    async (workflowId: string): Promise<string | null> => {
      if (!workspaceId) return null;
      const ok = await confirm({
        title: `Delete workflow "${workflowId}"?`,
        body: "Its folder is removed from main and it stops running: its schedule and webhook are turned off. The files stay in git history.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return null;
      const result = await deleteWorkflow(workspaceId, workflowId);
      return result.ok ? null : (result.error ?? "Failed to delete");
    },
    [workspaceId, confirm, deleteWorkflow],
  );
}
