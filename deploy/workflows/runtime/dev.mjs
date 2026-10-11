// A person's sandbox worker: the workflows of their checkout, as they are on
// disk, running next to production under that person's own names
// (HATCHET_CLIENT_NAMESPACE, `sb_<user>_`) with every trigger off. Started by
// Mako in the sandbox when a sandbox run is asked for; restarts itself when a
// file under `workflows/` changes; dies with the sandbox.
//
// Env: WORKFLOWS_ROOT (the checkout), HATCHET_CLIENT_TOKEN,
// HATCHET_CLIENT_NAMESPACE, MAKO_URL, MAKO_API_KEY.
import { fork } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_DIR, prepare, typecheck } from "./build.mjs";

const RESTART_DEBOUNCE_MS = 500;
const source = join(process.env.WORKFLOWS_ROOT, "workflows");

let child = null;
let root = null;
let timer = null;

function stop() {
  if (child) child.kill("SIGTERM");
  child = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
}

function start() {
  stop();
  // A copy, not the checkout: the packages symlink and the generated files
  // stay out of the repository, and the worker keeps reading a tree that is
  // not changing under it.
  root = mkdtempSync(join(tmpdir(), "mako-sandbox-"));
  cpSync(source, join(root, "workflows"), { recursive: true });
  prepare(root);
  const errors = typecheck(root);
  if (errors)
    console.error(`Type errors (the worker starts anyway):\n${errors}`);
  child = fork(join(RUNTIME_DIR, "worker.mjs"), {
    env: {
      ...process.env,
      WORKFLOWS_ROOT: root,
      GIT_SHA: "sandbox",
      SANDBOX: "1",
    },
    stdio: "inherit",
  });
  child.once("exit", code => {
    if (code) console.error(`Sandbox worker exited with code ${code}`);
  });
}

start();
watch(source, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log("workflows/ changed: restarting");
    start();
  }, RESTART_DEBOUNCE_MS);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
