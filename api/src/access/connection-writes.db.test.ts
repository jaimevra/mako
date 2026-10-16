/**
 * Who may write through a connection, against an in-memory Mongo and the
 * real query path: reports first, refuses once enforced, never touches
 * reads, records what it sees, and is changed only in the app.
 *
 * Postgres itself is stubbed: a statement that is not refused succeeds at
 * once, so "refused" is told apart by the error alone.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import {
  DatabaseConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { requestContextStorage } from "../logging/context";
import { databaseConnectionService } from "../services/database-connection.service";
import { workspaceDatabaseRoutes } from "../routes/workspace-databases";
import { workspaceRoutes } from "../routes/workspaces";
import { ConnectionWriteEvent } from "./connection-write-event";
import {
  forgetWritesMode,
  principalsOutsideWorkspace,
} from "./connection-writes";

const PEOPLE = ["owner", "admin", "marc", "anna"] as const;
type Person = (typeof PEOPLE)[number];
const ROLE: Record<Person, string> = {
  owner: "owner",
  admin: "admin",
  marc: "member",
  anna: "member",
};
const keyOf = (p: Person) => `revops_writes_key_${p}_tests_only`;
const REFUSED =
  /only the people and workflows an admin allowed|You can write only/;

const app = new OpenAPIHono();
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
app.route("/api/workspaces", workspaceRoutes);

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  try {
    const ws = new Types.ObjectId();
    for (const p of PEOPLE) {
      await User.create({ _id: p, email: `${p}@example.com` });
      await WorkspaceMember.create({
        workspaceId: ws,
        userId: p,
        role: ROLE[p],
        joinedAt: new Date(),
      });
    }
    await Workspace.collection.insertOne({
      _id: ws,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "owner",
      settings: {},
      apiKeys: PEOPLE.map(p => ({
        _id: new Types.ObjectId(),
        name: p,
        keyHash: hashApiKey(keyOf(p)),
        prefix: keyOf(p).slice(0, 14),
        createdAt: new Date(),
        createdBy: p,
      })),
    });
    const db = await DatabaseConnection.create({
      workspaceId: ws,
      name: "Warehouse",
      type: "postgresql",
      connection: { host: "127.0.0.1", port: 1, database: "none" },
      createdBy: "owner",
      writers: [{ principal: "user:anna", where: "finance" }],
    });

    // What runs after the check is not under test here.
    (
      databaseConnectionService as unknown as {
        executePostgreSQLQuery: () => Promise<{ success: boolean }>;
      }
    ).executePostgreSQLQuery = async () => ({ success: true });

    const as = (person: Person | null, sql: string) => {
      const run = () => databaseConnectionService.executeQuery(db, sql);
      return person
        ? requestContextStorage.run(
            {
              requestId: "t",
              userId: person,
              method: "POST",
              path: "/",
              startTime: 0,
            },
            run,
          )
        : run();
    };
    const refused = async (person: Person | null, sql: string) =>
      REFUSED.test(String((await as(person, sql)).error ?? ""));
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    // Report (the default): nothing is refused, writes are recorded.
    assert.equal(
      await refused("marc", "INSERT INTO finance.x VALUES (1)"),
      false,
    );
    assert.equal(await refused("marc", "select * from finance.x"), false);
    await settle();
    const reported = await ConnectionWriteEvent.find({}).lean();
    assert.equal(reported.length, 1, "a read is never recorded");
    assert.equal(reported[0].principal, "user:marc");
    assert.equal(reported[0].target, "finance.x");
    assert.equal(reported[0].allowed, false);
    assert.equal(reported[0].mode, "report");

    // Enforce: only writers write, and only where they may.
    await Workspace.updateOne(
      { _id: ws },
      { $set: { "settings.connectionWrites": "enforce" } },
    );
    forgetWritesMode(String(ws));
    assert.equal(
      await refused("marc", "INSERT INTO finance.x VALUES (1)"),
      true,
    );
    assert.equal(await refused("marc", "select * from finance.x"), false);
    assert.equal(
      await refused("anna", "INSERT INTO finance.x VALUES (1)"),
      false,
    );
    assert.equal(
      await refused("anna", "CREATE TABLE finance.y AS SELECT 1"),
      false,
    );
    assert.equal(
      await refused("anna", "INSERT INTO crm.leads VALUES (1)"),
      true,
    );
    assert.equal(await refused("anna", "INSERT INTO x VALUES (1)"), true);
    // The admin is no writer either: the list decides.
    assert.equal(await refused("admin", "DELETE FROM finance.x"), true);
    // Syncs, flows and other work no request started: the system's.
    assert.equal(await refused(null, "DROP TABLE finance.x"), false);
    // A schedule writes as its owner.
    const scheduled = await databaseConnectionService.executeQuery(
      db,
      "DELETE FROM finance.x",
      { actor: "user:marc" },
    );
    assert.match(String(scheduled.error), REFUSED);

    // The routes, as each person, with their own API key.
    const call = (p: Person, method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${keyOf(p)}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const base = `/api/workspaces/${ws}/databases/${db._id}/writers`;

    await settle();
    const view = await call("marc", "GET", base);
    assert.equal(view.status, 200);
    const { data } = (await view.json()) as {
      data: {
        writers: { principal: string; where: string | null }[];
        mode: string;
        canEdit: boolean;
        recent: { principal: string; count: number; uncovered: string[] }[];
      };
    };
    assert.deepEqual(
      data.writers.map(w => [w.principal, w.where]),
      [["user:anna", "finance"]],
    );
    assert.equal(data.mode, "enforce");
    assert.equal(data.canEdit, false);
    const marc = data.recent.find(r => r.principal === "user:marc");
    assert.ok(marc && marc.count >= 2);
    assert.ok(marc.uncovered.includes("finance.x"), "marc may not write there");
    const anna = data.recent.find(r => r.principal === "user:anna");
    // Anna's finance writes are covered; another schema and an unnamed one
    // are not.
    assert.deepEqual(
      [...(anna?.uncovered ?? [])].sort(),
      ["crm.leads", "x"],
      "only what anna can't",
    );

    // Changed only in the app: no API key, even the owner's; no member.
    assert.equal(
      (await call("owner", "PUT", base, { writers: [] })).status,
      403,
    );
    assert.equal(
      (await call("marc", "PUT", base, { writers: [] })).status,
      403,
    );
    assert.equal(
      (
        await call(
          "owner",
          "PUT",
          `/api/workspaces/${ws}/settings/connection-writes`,
          {
            mode: "report",
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (await DatabaseConnection.findById(db._id).lean())?.writers?.length,
      1,
    );

    // Only members can be allowed (people; workflows are names).
    assert.deepEqual(
      await principalsOutsideWorkspace(String(ws), [
        "user:anna",
        "user:nobody",
        "workflow:crm-chat-issues",
      ]),
      ["user:nobody"],
    );

    console.log("connection writes route tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
