/**
 * Delete a workflow (docs/src/content/docs/workflows.md): its folder leaves
 * main in one commit and the worker is deployed without it. The rest is what
 * happens to any workflow that leaves main (retire.ts): once the worker runs
 * without it, Hatchet forgets it and its triggers are turned off. The files
 * stay in git history.
 */
import { WORKFLOWS_DIR } from "../apps/app-paths";
import { RepoRequiredError } from "../apps/config";
import { runGit } from "../apps/git";
import { DEFAULT_BRANCH } from "../apps/repository.service";
import { requireWorkspaceRepo } from "../apps/workspace-repo-required";
import {
  commitOnMainDurably,
  invalidatePullThrottle,
} from "../apps/worktree.service";
import { requestWorkflowsDeploy } from "../inngest/functions/workflows-deploy";
import { loggers } from "../logging";
import { HatchetError } from "./hatchet";
import { checkName } from "./webhook";

const logger = loggers.api("workflows-delete");

/** Whether `spec` (a `<commit>:<path>`) names a folder. */
async function isFolder(repoDir: string, spec: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["-C", repoDir, "cat-file", "-t", spec]);
    return stdout.trim() === "tree";
  } catch {
    return false;
  }
}

export async function deleteWorkflow(
  workspaceId: string,
  name: string,
  userId?: string,
): Promise<void> {
  checkName(name);
  const folder = `${WORKFLOWS_DIR}/${name}`;
  let repoDir: string;
  try {
    repoDir = await requireWorkspaceRepo(workspaceId);
  } catch (error) {
    if (error instanceof RepoRequiredError) {
      throw new HatchetError(error.message, 412);
    }
    throw error;
  }
  // Checked against main as the commit sees it: after the freshen, so a
  // workflow pushed from a laptop a moment ago is found.
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      if (
        !(await isFolder(repoDir, `refs/heads/${DEFAULT_BRANCH}:${folder}`))
      ) {
        throw new HatchetError(`Workflow ${name} not found on main`, 404);
      }
      return { deletePrefixes: [folder] };
    },
    { message: `Delete workflow ${name}` },
  );
  // Sandboxes are clones: each pulls the deletion on its next touch, so the
  // folder does not linger in the explorer, which lists the person's checkout.
  invalidatePullThrottle();
  await requestWorkflowsDeploy(workspaceId, userId, "push");
  logger.info("Workflow deleted", { workspaceId, name, userId });
}
