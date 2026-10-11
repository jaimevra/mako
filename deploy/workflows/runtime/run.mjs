// A sandbox run: one workflow of a checkout, as it is on disk, run once on a
// Hatchet engine of its own (embedded mode: a local engine with a bundled
// Postgres, no token, no network). Started by Mako in a person's sandbox
// (api/src/workflows/sandbox.ts); prints what Hatchet recorded of the run
// and exits. Schedules and event triggers are off: the workflow runs because
// it was started.
//
//   node run.mjs <workflow> <base64 of the JSON input>
//
// Env: WORKFLOWS_ROOT (the checkout), MAKO_URL, MAKO_API_KEY (for lib/mako).
import { fork } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedSidecar } from "@hatchet-dev/typescript-sdk/v1/embedded";
import { RUNTIME_DIR, prepare, typecheck } from "./build.mjs";

// The engine the sidecar runs. Pinned, so a box never fetches another one
// than the image carries.
const ENGINE_VERSION =
  process.env.HATCHET_CLIENT_EMBEDDED_VERSION || "v0.110.5";
const RUN_TIMEOUT_MS =
  Number(process.env.WORKFLOWS_SANDBOX_TIMEOUT_MS) || 300_000;
const WORKER_START_TIMEOUT_MS = 60_000;
const ENGINE_START_ATTEMPTS = 4;
const POLL_MS = 500;
const LOG_LINES_PER_STEP = 20;
const MAX_TEXT_CHARS = 4000;

const [name, encodedInput] = process.argv.slice(2);
const input = JSON.parse(
  Buffer.from(encodedInput ?? "", "base64").toString() || "{}",
);

let root;
let worker;
let engine;

/** Keep what Mako shows of a run, at a size that fits an exec's output. */
const clip = value =>
  typeof value === "string" && value.length > MAX_TEXT_CHARS
    ? value.slice(0, MAX_TEXT_CHARS)
    : value;
const pick = (row, keys) =>
  Object.fromEntries(keys.map(key => [key, clip(row?.[key])]));

async function finish(result) {
  worker?.kill("SIGKILL");
  if (root) rmSync(root, { recursive: true, force: true });
  const json = JSON.stringify(result);
  // Mako reads the file; by hand, the result is the last line printed.
  if (process.env.MAKO_SANDBOX_RESULT_FILE) {
    writeFileSync(process.env.MAKO_SANDBOX_RESULT_FILE, json);
  } else console.log(json);
  // Stop the engine before leaving: the next run starts its own on the same
  // data folder, and two cannot hold it.
  await engine?.stop().catch(() => undefined);
  process.exit(0);
}

try {
  // A copy, not the checkout: the packages link and the generated files stay
  // out of the repository.
  root = mkdtempSync(join(tmpdir(), "mako-sandbox-"));
  cpSync(
    join(process.env.WORKFLOWS_ROOT, "workflows"),
    join(root, "workflows"),
    {
      recursive: true,
    },
  );
  prepare(root);
  const errors = typecheck(root);
  if (errors) await finish({ buildError: errors });

  // A run that was killed can leave its engine holding the data folder for a
  // moment; try again before giving up.
  for (let attempt = 1; !engine; attempt++) {
    engine = await startEmbeddedSidecar({ version: ENGINE_VERSION }).catch(
      err => {
        if (attempt === ENGINE_START_ATTEMPTS) throw err;
        return null;
      },
    );
    if (!engine) await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  const api = async (path, init) => {
    const res = await fetch(`${engine.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${engine.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  // The same worker production runs, pointed at the local engine.
  let workerOutput = "";
  await new Promise((resolve, reject) => {
    worker = fork(join(RUNTIME_DIR, "worker.mjs"), {
      env: {
        ...process.env,
        WORKFLOWS_ROOT: root,
        GIT_SHA: "sandbox",
        SANDBOX: "1",
        HATCHET_CLIENT_TOKEN: engine.token,
        HATCHET_CLIENT_HOST_PORT: engine.grpcAddress,
        HATCHET_CLIENT_API_URL: engine.apiUrl,
        HATCHET_CLIENT_TLS_STRATEGY: "none",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.on("data", chunk => {
        process.stderr.write(chunk);
        workerOutput = (workerOutput + chunk).slice(-4000);
      });
    }
    const timer = setTimeout(
      () => reject(new Error("The worker did not start in time")),
      WORKER_START_TIMEOUT_MS,
    );
    worker.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(workerOutput.trim() || "The worker exited"));
    });
  }).catch(err => finish({ buildError: err.message }));

  const started = await api(
    `/api/v1/stable/tenants/${engine.tenantId}/workflow-runs/trigger`,
    {
      method: "POST",
      body: JSON.stringify({
        workflowName: name,
        input,
        additionalMetadata: { trigger: "sandbox" },
      }),
    },
  ).catch(err =>
    finish({
      buildError: `"${name}" is not a workflow in this checkout (workflows/${name}/workflow.ts).\n${err.message}`,
    }),
  );
  const runId = started.run.metadata.id;

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let detail;
  for (;;) {
    detail = await api(`/api/v1/stable/workflow-runs/${runId}`);
    const status = detail.run?.status;
    if (status !== "QUEUED" && status !== "RUNNING") break;
    if (Date.now() > deadline) {
      detail.run.status = "RUNNING";
      detail.run.errorMessage = `Still running after ${RUN_TIMEOUT_MS / 1000}s; a sandbox run ends here.`;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  const logs = {};
  for (const task of detail.tasks ?? []) {
    const id = task.metadata?.id;
    if (!id) continue;
    logs[id] = await api(`/api/v1/stable/tasks/${id}/logs`)
      .then(l =>
        (l.rows ?? [])
          .slice(-LOG_LINES_PER_STEP)
          .map(line => ({ message: clip(line.message) })),
      )
      .catch(() => []);
  }
  await finish({
    detail: {
      run: pick(detail.run, [
        "metadata",
        "status",
        "startedAt",
        "createdAt",
        "duration",
        "errorMessage",
        "input",
        "output",
        "additionalMetadata",
      ]),
      tasks: (detail.tasks ?? []).map(task =>
        pick(task, [
          "metadata",
          "actionId",
          "displayName",
          "taskInsertedAt",
          "status",
          "attempt",
          "duration",
          "output",
          "errorMessage",
        ]),
      ),
    },
    logs,
  });
} catch (err) {
  await finish({ buildError: err?.message ?? String(err) });
}
