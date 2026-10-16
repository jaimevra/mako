/**
 * What a push deploys: the workspace's slot follows `workflows/` on main.
 * What leaves the repository leaves the worker. Real git, in-memory Mongo,
 * a stored Hatchet token so no Hatchet is asked anything.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/on-push.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

const TOKEN = `x.${Buffer.from(
  JSON.stringify({ sub: "t", server_url: "https://hatchet.test" }),
).toString("base64url")}.y`;
const WORKFLOW = 'export default { name: "digest" };\n';

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-wf-push-"));
  process.env.APPS_GIT_ROOT = path.join(tmp, "repos");
  delete process.env.WORKFLOWS_WORKER_KEY;
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const { Workspace } = await import("../database/workspace-schema");
  const { runGit } = await import("../apps/git");
  const { initRepo, repoDirFor } = await import("../apps/repository.service");
  const { deployWorkflowsFromRepo, hasWorkflowsToDeploy, recordWorkerReport } =
    await import("./on-push");
  // Hatchet, as far as retiring needs it: each workflow has an id derived
  // from its name, and every DELETE is recorded. `down` makes it fail.
  const deleted: string[] = [];
  let down = false;
  const idOf = (name: string) =>
    `00000000-0000-0000-0000-${Buffer.from(name).toString("hex").padStart(12, "0").slice(-12)}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (down) throw new Error("connection refused");
    const url = new URL(String(input));
    if (init?.method === "DELETE") {
      deleted.push(url.pathname.split("/").pop() ?? "");
      return new Response(null, { status: 204 });
    }
    const name = url.searchParams.get("name") ?? "";
    return Response.json({ rows: [{ name, metadata: { id: idOf(name) } }] });
  }) as typeof fetch;
  try {
    const id = new Types.ObjectId();
    const ws = id.toString();
    await Workspace.collection.insertOne({
      _id: id,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "owner",
      workflows: { hatchetToken: TOKEN },
    });
    const repo = repoDirFor(ws);
    await initRepo(repo, { "README.md": "hi\n" });
    const git = (...args: string[]) => runGit(["-C", repo, ...args]);
    const slots = async () =>
      (await Workspace.findById(id).select("workflows").lean())?.workflows;

    // A commit on `branch`, from `parent`, with these files on top of it.
    const commit = async (
      branch: string,
      parent: string,
      files: Record<string, string | null>,
    ) => {
      const work = await fs.mkdtemp(path.join(tmp, "work-"));
      await runGit(["clone", "-q", repo, work]);
      await runGit(["-C", work, "checkout", "-q", parent]);
      for (const [file, body] of Object.entries(files)) {
        const target = path.join(work, file);
        if (body === null) await fs.rm(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, body);
        }
      }
      await runGit(["-C", work, "add", "-A"]);
      await runGit([
        ...["-C", work, "-c", "user.email=t@t", "-c", "user.name=T"],
        ...["commit", "-qm", branch],
      ]);
      await runGit(["-C", work, "push", "-q", "origin", `HEAD:${branch}`]);
      return (await git("rev-parse", `refs/heads/${branch}`)).stdout.trim();
    };

    // No workflows anywhere: nothing is set, and a push asks for no deploy.
    assert.equal(await hasWorkflowsToDeploy(ws), false);
    await deployWorkflowsFromRepo(ws, "owner");
    assert.equal((await slots())?.live, undefined);

    // A workflow committed on main is live.
    const onMain = await commit("main", "main", {
      "workflows/digest/workflow.ts": WORKFLOW,
    });
    assert.equal(await hasWorkflowsToDeploy(ws), true);
    await deployWorkflowsFromRepo(ws, "owner");
    assert.equal((await slots())?.live?.sha, onMain);

    // A commit elsewhere in the repository leaves the slot alone: the worker
    // is pointed at a new commit only when `workflows/` changed.
    await commit("main", "main", { "README.md": "changed\n" });
    await deployWorkflowsFromRepo(ws);
    assert.equal((await slots())?.live?.sha, onMain);

    // A workflow that leaves main is retired once the worker runs without
    // it: Hatchet forgets it, its switch and webhook go off. Not before.
    await Workspace.updateOne(
      { _id: id },
      {
        $set: {
          "workflows.active": ["digest", "other"],
          "workflows.webhooks": { digest: "x", other: "y" },
        },
      },
    );
    await recordWorkerReport(ws, onMain);
    const both = await commit("main", "main", {
      "workflows/other/workflow.ts": WORKFLOW,
    });
    await deployWorkflowsFromRepo(ws);
    await recordWorkerReport(ws, both);
    assert.deepEqual((await slots())?.live?.running?.names, [
      "digest",
      "other",
    ]);
    const withoutDigest = await commit("main", "main", {
      "workflows/digest": null,
    });
    await deployWorkflowsFromRepo(ws);
    // Deployed but not running yet, then a build that failed: the previous
    // commit still runs digest.
    await recordWorkerReport(ws, withoutDigest, "type error");
    assert.deepEqual(deleted, []);
    assert.deepEqual((await slots())?.active, ["digest", "other"]);
    // A report for a commit no longer wanted changes nothing.
    await recordWorkerReport(ws, both);
    assert.deepEqual(deleted, []);
    await recordWorkerReport(ws, withoutDigest);
    assert.deepEqual(deleted, [idOf("digest")]);
    assert.deepEqual((await slots())?.active, ["other"]);
    assert.deepEqual(Object.keys((await slots())?.webhooks ?? {}), ["other"]);
    assert.deepEqual((await slots())?.retired, []);

    // Hatchet down: the name stays queued, and the next deploy retries it.
    deleted.length = 0;
    const renamed = await commit("main", "main", {
      "workflows/other": null,
      "workflows/renamed/workflow.ts": WORKFLOW,
    });
    await deployWorkflowsFromRepo(ws);
    down = true;
    await recordWorkerReport(ws, renamed);
    assert.deepEqual((await slots())?.retired, ["other"]);
    assert.deepEqual((await slots())?.active, ["other"]);
    down = false;
    await deployWorkflowsFromRepo(ws);
    assert.deepEqual(deleted, [idOf("other")]);
    assert.deepEqual((await slots())?.retired, []);
    assert.deepEqual((await slots())?.active, []);
    deleted.length = 0;

    // `workflows/` deleted on main: still a deploy (something is live to
    // drop), and then nothing is live and nothing more to ask for.
    await commit("main", "main", { workflows: null });
    assert.equal(await hasWorkflowsToDeploy(ws), true);
    await deployWorkflowsFromRepo(ws);
    assert.equal((await slots())?.live, undefined);
    assert.equal(await hasWorkflowsToDeploy(ws), false);
    // The worker stops and reports nothing more: what it ran is retired.
    assert.deepEqual(deleted, [idOf("renamed")]);

    console.log("workflows on-push tests passed");
  } finally {
    globalThis.fetch = realFetch;
    await mongoose.disconnect();
    await mongo.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
