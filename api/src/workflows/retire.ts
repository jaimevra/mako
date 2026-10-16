/**
 * What happens to a workflow that leaves main, however it left (the Delete
 * button, a push, a merge, a rename): once the worker reports running a
 * commit without it, Hatchet forgets it, so its schedule stops, and its
 * Active switch and webhook are turned off here, so a workflow committed
 * again under the name starts inactive and the old URL starts nothing.
 *
 * Not before: a commit that does not build leaves the previous one running,
 * and that one still holds the workflow. The names wait in
 * `workflows.retired` until done, so a Hatchet that was down is retried by
 * the next report or deploy (the hourly reconcile included).
 */
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { deleteWorkflowDefinition, readWorkspaceTenant } from "./hatchet";
import { setTriggers } from "./webhook";

const logger = loggers.api("workflows-retire");

/** Queue `names` to be retired, then retire everything queued. */
export async function retireWorkflows(
  workspaceId: string,
  names: string[],
): Promise<void> {
  if (names.length > 0) {
    await Workspace.updateOne(
      { _id: new Types.ObjectId(workspaceId) },
      { $addToSet: { "workflows.retired": { $each: names } } },
    );
  }
  await retireQueued(workspaceId);
}

/**
 * Retire the queued names. One that main holds again is dropped from the
 * queue untouched: it came back before it was retired.
 */
export async function retireQueued(workspaceId: string): Promise<void> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows.retired workflows.live.names")
    .lean();
  const queued = workspace?.workflows?.retired ?? [];
  if (queued.length === 0) return;
  const onMain = new Set(workspace?.workflows?.live?.names ?? []);
  const tenant = await readWorkspaceTenant(workspaceId).catch(() => null);
  for (const name of queued) {
    try {
      if (!onMain.has(name)) {
        if (tenant) await deleteWorkflowDefinition(tenant, name);
        await setTriggers(workspaceId, name, { active: false, webhook: false });
        logger.info("Workflow retired", { workspaceId, name });
      }
      await Workspace.updateOne(
        { _id: new Types.ObjectId(workspaceId) },
        { $pull: { "workflows.retired": name } },
      );
    } catch (error) {
      // Stays queued: the next report or deploy tries again.
      logger.warn("Workflow retire failed", {
        workspaceId,
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
