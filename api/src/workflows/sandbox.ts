/**
 * A person's sandbox worker: `dev.mjs` from the workflow runtime, started in
 * their sandbox (the same box their apps dev server runs in), serving the
 * workflows of their checkout as they are on disk under their own names
 * (`sb_<user>_`, hatchet.ts) with every trigger off. Mako starts it when a
 * sandbox run is asked for and leaves it running; it restarts itself on
 * file changes and dies with the box.
 *
 * It is the workspace's worker in every other respect: the same Hatchet
 * tenant and token, the same Mako key, so `query()`, `call()` and `agent()`
 * behave as they will on main.
 */
import { getSandboxProvider } from "../apps/sandbox/provider";
import { boxCtx, ensureWorkspaceWorktree } from "../apps/worktree.service";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  HatchetError,
  listWorkers,
  sandboxPrefix,
  type WorkspaceTenant,
} from "./hatchet";
import { isGkeWorkerConfigured, makoUrl, readWorkerSecret } from "./kube";
import { workerKeyName } from "./on-push";

const logger = loggers.api("workflows-sandbox");

/** Where the runtime (dev.mjs and its packages) is inside a box. */
const RUNTIME_IN_BOX =
  process.env.WORKFLOWS_RUNTIME_DIR_IN_BOX || "/opt/mako-workflows";
const SOCK = "/tmp/mako-workflows-dev.sock";
const LOG = "/tmp/mako-workflows-dev.log";
const START_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;

/**
 * The worker's Mako key: the workspace's own, as its pod has it. `gke` keeps
 * it in the pod's Secret; `static` runs with WORKFLOWS_WORKER_KEY.
 */
async function workerKey(workspaceId: string): Promise<string> {
  // The workspace has a worker once a deploy gave it the key (on-push.ts);
  // the static key in particular serves one workspace, so it is handed out
  // only to that one.
  const workspace = await Workspace.findById(workspaceId)
    .select("apiKeys.name")
    .lean();
  const named = workspace?.apiKeys?.some(k => k.name === workerKeyName());
  const key = !named
    ? null
    : isGkeWorkerConfigured()
      ? await readWorkerSecret(workspaceId)
      : (process.env.WORKFLOWS_WORKER_KEY ?? null);
  if (key) return key;
  throw new HatchetError(
    named
      ? "The worker's key is not readable here; redeploy the workflows once."
      : "No worker yet: commit a workflow to main first, then the sandbox can run.",
    409,
  );
}

const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Make sure the person's sandbox worker is up and registered with Hatchet.
 * Idempotent: a running one is left alone.
 */
export async function ensureSandboxWorker(
  tenant: WorkspaceTenant,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const prefix = sandboxPrefix(userId);
  const up = async () =>
    (await listWorkers(tenant)).some(
      w => w.name.startsWith(prefix) && w.status === "ACTIVE",
    );
  if (await up()) return;

  const provider = getSandboxProvider();
  const handle = await ensureWorkspaceWorktree(workspaceId, userId);
  const ctx = boxCtx(handle);
  const env = {
    WORKFLOWS_ROOT: provider.root(ctx),
    HATCHET_CLIENT_TOKEN: tenant.token,
    HATCHET_CLIENT_NAMESPACE: prefix,
    MAKO_URL: makoUrl(),
    MAKO_API_KEY: await workerKey(workspaceId),
    HOME: "/tmp",
  };
  // Same shape as the apps dev server: a headless dtach session, nohup as
  // the fallback. The env goes to the process, never to a file in the box.
  const exports = Object.entries(env)
    .map(([name, value]) => `${name}=${sh(value)}`)
    .join(" ");
  const run = `${exports} node ${RUNTIME_IN_BOX}/dev.mjs`;
  const command =
    `if pgrep -f "dtach -n ${SOCK}" >/dev/null 2>&1; then echo running; ` +
    `elif command -v dtach >/dev/null; then rm -f ${SOCK}; dtach -n ${SOCK} sh -c ${sh(`${run} >> ${LOG} 2>&1`)}; echo started; ` +
    `else nohup sh -c ${sh(run)} >> ${LOG} 2>&1 & echo started; fi`;
  await provider.execDetached(ctx, command, { timeoutMs: 60_000 });
  logger.info("Sandbox worker starting", { workspaceId, userId });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    if (await up()) return;
  }
  const tail = await provider
    .exec(ctx, `tail -n 30 ${LOG} 2>/dev/null`, { timeoutMs: 15_000 })
    .then(r => r.stdout.trim())
    .catch(() => "");
  throw new HatchetError(
    `The sandbox worker did not connect to Hatchet.${tail ? `\n${tail}` : ""}`,
    502,
  );
}
