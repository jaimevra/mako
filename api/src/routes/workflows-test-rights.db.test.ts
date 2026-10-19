/**
 * Workflow code run by a person (`mako workflow run`, a sandbox run) calls
 * the worker's SQL, model and agent routes with the person's own credential
 * and the workflow's name (X-Mako-Workflow). It may then do only what BOTH
 * the person and the workflow may: the header narrows, it never widens. The
 * deployed worker's key keeps exactly the workflow's rights.
 *
 * Real auth middleware and routes over HTTP, in-memory Mongo. The SQL runs
 * on a real Postgres when MAKO_TEST_POSTGRES_URL is set (the test makes and
 * drops its own schema); otherwise a stand-in answers the driver calls. The
 * AI gateway is a stand-in that records what it was sent.
 *
 * Run with: pnpm --filter api exec tsx src/routes/workflows-test-rights.db.test.ts
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { asSystem } from "../access/connection-writes";
import { hashApiKey } from "../auth/api-key.middleware";
import { mintMcpAccessTokenForUser } from "../auth/mcp-oauth.service";
import { User } from "../database/schema";
import {
  DatabaseConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { databaseConnectionService } from "../services/database-connection.service";
import { WORKER_KEY_SCOPES, workerKeyName } from "../workflows/worker-key";
import { workflowRuntimeRoutes } from "./workflows";

const WORKER_KEY = "revops_worker_test_rights_key_tests";
const PERSON_KEY = "revops_person_test_rights_key_tests";
const NO_RUN_KEY = "revops_person_without_run_scope_xx";
const SCHEMA = `mako_tr_${Date.now().toString(36)}`;
const WRITE = (table: string) =>
  `INSERT INTO ${SCHEMA}.${table} (id) VALUES (1)`;

const app = new Hono();
app.use("*", loggingMiddleware({}));
app.route("/api/workflows/runtime", workflowRuntimeRoutes);

const post = async (
  path: string,
  key: string,
  body: unknown,
  workflow?: string,
  headers: Record<string, string> = {},
) => {
  const res = await app.request(`/api/workflows/runtime${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(workflow ? { "x-mako-workflow": workflow } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

async function main() {
  const postgresUrl = process.env.MAKO_TEST_POSTGRES_URL;
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  process.env.AI_GATEWAY_API_KEY = "gateway-key";
  const ws = new Types.ObjectId();
  let db: { _id: Types.ObjectId } | null = null;
  try {
    for (const id of ["deployer", "marc"]) {
      await User.create({ _id: id, email: `${id}@example.com` });
      await WorkspaceMember.create({
        workspaceId: ws,
        userId: id,
        role: id === "deployer" ? "owner" : "member",
        joinedAt: new Date(),
      });
    }
    const key = (
      name: string,
      value: string,
      scopes: string[],
      by: string,
    ) => ({
      _id: new Types.ObjectId(),
      name,
      keyHash: hashApiKey(value),
      prefix: value.slice(0, 14),
      scopes,
      createdAt: new Date(),
      createdBy: by,
    });
    await Workspace.collection.insertOne({
      _id: ws,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "deployer",
      settings: {},
      apiKeys: [
        key(workerKeyName(), WORKER_KEY, WORKER_KEY_SCOPES, "deployer"),
        key(
          "Marc's",
          PERSON_KEY,
          ["mcp", "query:write", "workflows:run"],
          "marc",
        ),
        key("Marc's MCP", NO_RUN_KEY, ["mcp", "query:write"], "marc"),
      ],
      workflows: {
        live: { sha: "a".repeat(40), tree: "t", names: ["billing-sync"] },
      },
    });
    // Each table is writable by a different set: both, the person only, the
    // workflow only.
    db = await DatabaseConnection.create({
      workspaceId: ws,
      name: "local_pg",
      type: "postgresql",
      connection: postgresUrl
        ? {
            connectionString: postgresUrl,
            database: new URL(postgresUrl).pathname.slice(1) || "postgres",
          }
        : { host: "stub", database: "stub" },
      createdBy: "deployer",
      writers: [
        { principal: "user:marc", where: `${SCHEMA}.both` },
        { principal: "user:marc", where: `${SCHEMA}.person_only` },
        { principal: "workflow:billing-sync", where: `${SCHEMA}.both` },
        {
          principal: "workflow:billing-sync",
          where: `${SCHEMA}.workflow_only`,
        },
      ],
    });
    const connectionId = String(db._id);
    const target = db;
    const ran: string[] = [];
    if (postgresUrl) {
      const setup = await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `CREATE SCHEMA ${SCHEMA};
           CREATE TABLE ${SCHEMA}.both (id int);
           CREATE TABLE ${SCHEMA}.person_only (id int);
           CREATE TABLE ${SCHEMA}.workflow_only (id int);`,
        ),
      );
      assert.equal(setup.success, true, JSON.stringify(setup));
    } else {
      // Writes and reads, as the driver answers them.
      const service = databaseConnectionService as unknown as Record<
        "executePostgreSQLQuery" | "executePostgreSQLCursor",
        (db: unknown, q: string) => Promise<unknown>
      >;
      service.executePostgreSQLQuery = service.executePostgreSQLCursor = async (
        _db,
        q,
      ) => {
        ran.push(q);
        return { success: true, data: [], rowCount: 1 };
      };
    }
    const query = (key: string, sql: string, workflow?: string) =>
      post("/query", key, { connectionId, query: sql }, workflow);
    const rowsIn = async (table: string) =>
      postgresUrl
        ? (
            (
              await asSystem(() =>
                databaseConnectionService.executeQuery(
                  target as never,
                  `SELECT count(*)::int AS n FROM ${SCHEMA}.${table}`,
                ),
              )
            ).data?.[0] as { n: number }
          ).n
        : ran.filter(q => q === WRITE(table)).length;

    // 1. The deployed worker: the workflow's rights, as before.
    let res = await query(WORKER_KEY, WRITE("workflow_only"), "billing-sync");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const workerRefused = await query(
      WORKER_KEY,
      WRITE("person_only"),
      "billing-sync",
    );
    assert.equal(workerRefused.status, 400);

    // 2. A person naming the workflow: a write passes where both may.
    res = await query(PERSON_KEY, WRITE("both"), "billing-sync");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await rowsIn("both"), 1);

    // 3. Where only the person may: refused with the error production gives
    //    the workflow (case 1's refusal of the same kind).
    const personOnly = await query(
      PERSON_KEY,
      WRITE("person_only"),
      "billing-sync",
    );
    assert.equal(personOnly.status, 400);
    assert.equal(personOnly.body.error, workerRefused.body.error);
    assert.equal(await rowsIn("person_only"), 0);

    // 4. Where only the workflow may: refused too. The header never gives a
    //    person the workflow's rights.
    const workflowOnly = await query(
      PERSON_KEY,
      WRITE("workflow_only"),
      "billing-sync",
    );
    assert.equal(workflowOnly.status, 400);
    assert.match(workflowOnly.body.error, /You can write only to/);
    assert.equal(await rowsIn("workflow_only"), 1, "only the worker's write");

    // A workflow the workspace has not deployed opens nothing.
    const undeployed = await query(PERSON_KEY, "SELECT 1", "draft-flow");
    assert.deepEqual(
      [undeployed.status, undeployed.body.error],
      [401, "Invalid worker key"],
    );

    // Without the header a person is not a worker: the routes stay closed.
    res = await query(PERSON_KEY, WRITE("both"));
    assert.deepEqual([res.status, res.body.error], [401, "Invalid worker key"]);
    // And a person's key needs the workflows:run grant to call them at all.
    res = await query(NO_RUN_KEY, WRITE("both"), "billing-sync");
    assert.equal(res.status, 403);
    // The worker's other routes (head, source, reports) stay the worker's.
    const head = await app.request("/api/workflows/runtime/head", {
      headers: {
        Authorization: `Bearer ${PERSON_KEY}`,
        "x-mako-workflow": "billing-sync",
      },
    });
    assert.equal(head.status, 403);

    // A person's login (`mako login`, an MCP OAuth token): the same routes.
    const { accessToken: login } = await mintMcpAccessTokenForUser({
      userId: "marc",
      workspaceId: String(ws),
    });
    res = await query(login, "SELECT 1 AS one", "billing-sync");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The login reads only (query:read), whatever the writers list says.
    res = await query(login, WRITE("both"), "billing-sync");
    assert.equal(res.status, 400);

    // The model route, with the person's login and the workflow's name.
    const sent: Array<{ url: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({ content: [], finishReason: "stop" }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    try {
      res = await post(
        "/ai/language-model",
        login,
        { prompt: [] },
        "billing-sync",
        {
          "ai-language-model-id": "anthropic/claude-haiku-4.5",
          "ai-language-model-specification-version": "3",
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const gateway = sent.filter(s => s.url.includes("/language-model"));
    assert.equal(gateway.length, 1, JSON.stringify(sent.map(s => s.url)));
    assert.equal(
      gateway[0].auth,
      "Bearer gateway-key",
      "Mako's gateway key, not the person's",
    );

    console.log(
      `workflow test rights tests passed${postgresUrl ? " (real Postgres)" : ""}`,
    );
  } finally {
    if (postgresUrl && db) {
      const target = db;
      await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`,
        ),
      ).catch(() => undefined);
    }
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
