// One Hatchet worker running the workflows of one commit, started by
// entrypoint.mjs. A workflow is `workflows/<name>/workflow.ts` whose default
// export is the workflow named `<name>`. A preview (PREVIEW=1) gets prefixed
// names and no schedules or event triggers: it runs only when started.
//
// Env: WORKFLOWS_ROOT, GIT_SHA, HATCHET_CLIENT_TOKEN.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

register();
const READY_TIMEOUT_MS = 45_000;
const dir = join(process.env.WORKFLOWS_ROOT, "workflows");
const load = file => import(pathToFileURL(join(dir, file)).href);

const { hatchet } = await load("hatchet.ts");
// The client has the token now; workflow code must not. A preview could
// otherwise make its own client without the preview namespace.
delete process.env.HATCHET_CLIENT_TOKEN;
if (!hatchet) {
  console.error("workflows/hatchet.ts must export { hatchet }");
  process.exit(1);
}

const workflows = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const file = join(entry.name, "workflow.ts");
  if (!entry.isDirectory() || !existsSync(join(dir, file))) continue;
  const workflow = (await load(file)).default;
  // The folder name is the workflow's id everywhere, so the two must agree.
  const name = workflow?.definition?.name;
  if (name !== entry.name) {
    console.error(
      `workflows/${file} must default-export the workflow named "${entry.name}"` +
        (name ? `, not "${name}"` : ""),
    );
    process.exit(1);
  }
  if (process.env.PREVIEW) {
    for (const trigger of ["on", "onCrons", "onEvents"]) {
      delete workflow.definition[trigger];
    }
  }
  workflows.push(workflow);
}

if (workflows.length === 0) {
  // A workflow file in the wrong place is a mistake in the layout, not a
  // deploy: say where it is, so a file one folder too deep is seen at once.
  const found = readdirSync(dir, { recursive: true })
    .filter(file => String(file).endsWith("workflow.ts"))
    .map(file => `workflows/${file}`);
  if (found.length) {
    console.error(
      "No workflow found. A workflow is the file workflows/<name>/workflow.ts." +
        ` Found instead: ${found.join(", ")}`,
    );
    process.exit(1);
  }
  // No workflow at all (the last one was deleted, shared files remain) is a
  // deploy of nothing: this process takes over from the previous one and
  // idles, so what was deleted stops running.
  console.log(`Worker started at ${process.env.GIT_SHA}: no workflows`);
  process.send?.("ready");
  process.on("SIGTERM", () => process.exit(0));
  await new Promise(() => {});
}

const worker = await hatchet.worker("workspace", {
  workflows,
  slots: 50,
  labels: { git_sha: process.env.GIT_SHA },
});

process.on("SIGTERM", async () => {
  console.log(`${process.env.GIT_SHA}: finishing running tasks`);
  await worker.stop();
  process.exit(0);
});

worker.start().catch(err => {
  console.error("Worker stopped:", err);
  process.exit(1);
});
// Ready means connected and registered, not merely started: the previous
// worker is stopped only once this one can take its place.
await worker.waitUntilReady(READY_TIMEOUT_MS).catch(err => {
  console.error("Worker did not connect to Hatchet:", err.message);
  process.exit(1);
});
console.log(
  `Worker started at ${process.env.GIT_SHA}: ${workflows.length} workflows`,
);
process.send?.("ready");
