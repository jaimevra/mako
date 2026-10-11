/**
 * Workflow agent tools (docs/src/content/docs/workflows.md). An agent writes
 * a workflow with the `app_*` shell, file and git tools (`workflowId`), and a
 * merge is the deploy. What is left is to look (`workflows_status`) and to
 * start a run (`workflows_run`).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { workspaceService } from "../../services/workspace.service";
import {
  requireTenant,
  sandboxPrefix,
  startRun,
} from "../../workflows/hatchet";
import { readRun, readWorkflowsOverview } from "../../workflows/runs";
import { WORKFLOWS_ADMIN_ONLY } from "../../workflows/policy";
import { ensureSandboxWorker } from "../../workflows/sandbox";
import { setActive, setWebhook } from "../../workflows/webhook";

/** How many recent runs an agent is shown. */
const RECENT_RUNS = 10;

const failure = (error: unknown) => ({
  success: false as const,
  error: error instanceof Error ? error.message : String(error),
});

export function createWorkflowTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  /** Viewers look; members start runs; admins activate and add webhooks. */
  const roleIs = async (roles: string[]) =>
    !userId || workspaceService.hasRole(workspaceId, userId, roles);
  const mayRun = () => roleIs(["owner", "admin", "member"]);
  const mayChange = () => roleIs(["owner", "admin"]);

  return {
    workflows_status: tool({
      description:
        "Look at this workspace's workflows. Without runId: what is deployed (`deployment`: the code on main), the build error if a commit did not start (`buildError` — the old code keeps running), whether your sandbox worker is up (`sandbox.running`), the workflows (each with `active`, and `webhookUrl` when one has a webhook) and schedules, and the last runs (`sandbox` set on a sandbox run). With runId: that run's steps, each with status, output, error and its last log lines (what the step wrote with ctx.logger). While `liveSha` is not yet `targetSha` the worker has not switched to the new commit; call again in a few seconds.",
      inputSchema: z.object({
        runId: z
          .string()
          .optional()
          .describe("A run id from workflows_run or from recentRuns"),
      }),
      execute: async ({ runId }) => {
        try {
          if (!runId) {
            return {
              success: true,
              ...(await readWorkflowsOverview(workspaceId, RECENT_RUNS, {
                asAdmin: await mayChange(),
                userId,
              })),
            };
          }
          const tenant = await requireTenant(workspaceId);
          return { success: true, run: await readRun(tenant, runId) };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_run: tool({
      description:
        "Start a run of a workflow and get its runId; follow it with workflows_status({ runId }). With `sandbox: true` it runs the workflow as it is in your checkout right now, uncommitted edits included, with real data and no schedule: that is how a change is tested. Without it, the deployed code on main runs, active or not. The first sandbox run after a change takes a few seconds longer while the sandbox worker loads it.",
      inputSchema: z.object({
        workflowId: z
          .string()
          .min(1)
          .describe('The workflow\'s folder name, e.g. "daily-digest"'),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The run's input object (default {})"),
        sandbox: z
          .boolean()
          .optional()
          .describe("Run your checkout's version instead of the deployed one"),
      }),
      execute: async ({ workflowId, input, sandbox }) => {
        try {
          if (!(await mayRun())) {
            return { success: false, error: "Viewers cannot start runs." };
          }
          const tenant = await requireTenant(workspaceId);
          let workflowName = workflowId;
          if (sandbox) {
            if (!userId) {
              return { success: false, error: "A sandbox needs a person." };
            }
            await ensureSandboxWorker(tenant, workspaceId, userId);
            workflowName = `${sandboxPrefix(userId)}${workflowId}`;
          }
          const runId = await startRun(tenant, workflowName, {
            input,
            trigger: "agent",
          });
          return { success: true, runId, workflowId, sandbox: !!sandbox };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_activate: tool({
      description:
        "Turn a workflow's triggers on or off. A workflow is deployed with its schedule and webhook off and runs only when started; activating it starts its `on: { cron }` schedule and its webhook. Ask the user before activating: from then on it runs by itself.",
      inputSchema: z.object({
        workflowId: z.string().describe("The workflow's name"),
        active: z.boolean(),
      }),
      execute: async ({ workflowId, active }) => {
        try {
          if (!(await mayChange())) {
            return { success: false, error: WORKFLOWS_ADMIN_ONLY };
          }
          await setActive(workspaceId, workflowId, active);
          return { success: true, workflowId, active };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_webhook: tool({
      description:
        "Give a workflow a webhook, or remove it. With `enabled: true` it returns a new URL: a POST to it starts a run with the request's JSON body as the input, while the workflow is active. The URL carries its own secret; removing the webhook and adding it again gives a new URL and the old one stops working. A schedule is not set here: write `on: { cron }` in the workflow's code.",
      inputSchema: z.object({
        workflowId: z.string().describe("The workflow's name"),
        enabled: z.boolean(),
      }),
      execute: async ({ workflowId, enabled }) => {
        try {
          if (!(await mayChange())) {
            return { success: false, error: WORKFLOWS_ADMIN_ONLY };
          }
          return {
            success: true,
            workflowId,
            webhookUrl: await setWebhook(workspaceId, workflowId, enabled),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
