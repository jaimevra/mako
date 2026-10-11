/**
 * Deploy a workspace's workflows when its repo moves
 * (docs/src/content/docs/workflows.md).
 *
 * A deploy is one write: the commit and tree of `workflows/` at `main`, saved
 * as the workspace's target. The worker asks for it and switches to it when
 * it builds. Before the first deploy this also gives the workspace its
 * Hatchet token and its worker.
 */
import { Types } from "mongoose";

import { WORKFLOWS_DIR } from "../apps/app-paths";
import { ensureLocalRepo } from "../apps/cloud-repo.service";
import { runGit } from "../apps/git";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import { generateApiKey, hashApiKey } from "../auth/api-key.middleware";
import type { WorkspaceApiKeyScope } from "../auth/api-key-scopes";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  HatchetError,
  ensureWorkspaceTenant,
  hasInstanceHatchet,
  workflowsNamePrefix,
} from "./hatchet";
import {
  ensureWorkerDeployment,
  isGkeWorkerConfigured,
  readWorkerSecret,
  writeWorkerSecret,
} from "./kube";

const logger = loggers.api("workflows-on-push");

/** One key per environment that runs a worker: previews share a database. */
export const workerKeyName = () =>
  `Workflows worker ${workflowsNamePrefix()}`.trim();
const WORKER_KEY_SCOPES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:read",
  "workflows:runtime",
];

/** The tree id of `workflows/` at a commit, or null when it has none. */
async function workflowsTree(
  repoDir: string,
  commit: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${commit}:${WORKFLOWS_DIR}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Make `key` the workspace's worker key, replacing any earlier one. */
async function setWorkerKey(
  workspaceId: string,
  userId: string,
  key: string,
): Promise<void> {
  const _id = new Types.ObjectId(workspaceId);
  const keyHash = hashApiKey(key);
  const holder = await Workspace.findOne({ "apiKeys.keyHash": keyHash })
    .select("_id")
    .lean();
  if (holder) {
    if (holder._id.equals(_id)) return;
    throw new Error(
      "WORKFLOWS_WORKER_KEY already belongs to another workspace. A static worker serves one workspace.",
    );
  }
  // The scope is the worker's alone, so it finds the key being replaced.
  await Workspace.updateOne(
    { _id },
    { $pull: { apiKeys: { name: workerKeyName() } } },
  );
  await Workspace.updateOne(
    { _id },
    {
      $push: {
        apiKeys: {
          _id: new Types.ObjectId(),
          name: workerKeyName(),
          keyHash,
          prefix: key.substring(0, 14),
          scopes: WORKER_KEY_SCOPES,
          createdAt: new Date(),
          createdBy: userId,
        },
      },
    },
  );
}

/**
 * The key the workspace's workers sign in to Mako with, made if missing.
 * Where this API can create pods (`gke`) the key lives in two places, this
 * environment's key on the workspace and the pod's Secret; either missing (a
 * first deploy, a database restored from before the worker, a new cluster)
 * means a new key written to both, replacing what the pod held. Elsewhere
 * the operator runs the runtime image with WORKFLOWS_WORKER_KEY (`static`)
 * and that one key serves one workspace. A person's sandbox worker uses the
 * same key (sandbox.ts).
 */
export async function ensureWorkerKey(
  workspaceId: string,
  userId: string,
): Promise<string> {
  if (!isGkeWorkerConfigured()) {
    const key = process.env.WORKFLOWS_WORKER_KEY;
    if (!key?.startsWith("revops_")) {
      throw new HatchetError(
        "Set WORKFLOWS_WORKER_KEY (revops_...) and start the worker with it",
        503,
      );
    }
    await setWorkerKey(workspaceId, userId, key);
    return key;
  }
  const workspace = await Workspace.findById(workspaceId)
    .select("apiKeys.name")
    .lean();
  if (workspace?.apiKeys?.some(k => k.name === workerKeyName())) {
    const stored = await readWorkerSecret(workspaceId);
    if (stored) return stored;
  }
  const { key } = generateApiKey();
  await setWorkerKey(workspaceId, userId, key);
  await writeWorkerSecret(workspaceId, key);
  return key;
}

/** Make sure the workspace's worker can sign in to Mako, and exists. */
async function ensureWorker(
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    await ensureWorkerKey(workspaceId, userId);
  } catch (error) {
    // A static install without the key: the deploy still records the
    // commit; the operator sees what to set.
    if (!isGkeWorkerConfigured() && error instanceof HatchetError) {
      logger.warn(error.message, { workspaceId });
      return;
    }
    throw error;
  }
  if (isGkeWorkerConfigured()) await ensureWorkerDeployment(workspaceId);
}

type Commit = { sha: string; tree: string };

/** `workflows/` on a branch, or null when the branch or the folder is missing. */
async function workflowsAt(
  repoDir: string,
  branch: string,
): Promise<Commit | null> {
  const sha = await resolveCommit(repoDir, `refs/heads/${branch}`);
  const tree = sha ? await workflowsTree(repoDir, sha) : null;
  return sha && tree ? { sha, tree } : null;
}

const deploys = new Map<string, Promise<void>>();

/**
 * Point the worker at `workflows/` on `main`. One at a time per workspace, in
 * order: a push that lands during a deploy is deployed after it, not dropped.
 */
export function deployWorkflowsFromRepo(
  workspaceId: string,
  userId?: string,
): Promise<void> {
  const run = (deploys.get(workspaceId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => deployWorkflowsNow(workspaceId, userId))
    .finally(() => {
      if (deploys.get(workspaceId) === run) deploys.delete(workspaceId);
    });
  deploys.set(workspaceId, run);
  return run;
}

async function deployWorkflowsNow(
  workspaceId: string,
  userId?: string,
): Promise<void> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows createdBy")
    .lean();
  // Nothing to deploy to without a Hatchet: Mako runs without workflows.
  const state = workspace?.workflows ?? {};
  if (!workspace || !(state.hatchetToken || hasInstanceHatchet())) return;
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return;
  const main = await workflowsAt(repoDir, DEFAULT_BRANCH);
  if (main) {
    await ensureWorkspaceTenant(workspaceId);
    await ensureWorker(workspaceId, userId ?? workspace.createdBy);
  }

  // The slot follows what the repository holds: `workflows/` deleted on main
  // is gone from the worker. The commit changes under the slot; what the
  // worker reported for the old one stays until it reports again, so the
  // screen shows old-live, new-wanted.
  if (main && state.live?.tree !== main.tree) {
    await Workspace.updateOne(
      { _id: workspace._id },
      {
        $set: {
          "workflows.live.sha": main.sha,
          "workflows.live.tree": main.tree,
        },
      },
    );
    logger.info("Set workflows target", { workspaceId, sha: main.sha });
  } else if (!main && state.live) {
    await Workspace.updateOne(
      { _id: workspace._id },
      { $unset: { "workflows.live": "" } },
    );
    logger.info("Unset workflows target", { workspaceId });
  }
}
