/**
 * PUT /databases/:id/write-grants against a real (in-memory) Mongo: who may
 * change grants, which grants are refused, and that grants never touch
 * allowAgentWrites (a grant must not widen what an MCP write key can do).
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
import { workspaceDatabaseRoutes } from "./workspace-databases";

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const FOREIGN_CONN = new Types.ObjectId();
const KEYS = {
  admin: "revops_admin_key_for_write_grants",
  member: "revops_member_key_for_write_grants",
  viewer: "revops_viewer_key_for_write_grants",
};

const app = new OpenAPIHono();
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);

const put = (key: string, conn: Types.ObjectId, body: unknown) =>
  app.request(`/api/workspaces/${WS}/databases/${conn}/write-grants`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const stored = async () =>
  (await DatabaseConnection.findById(CONN).lean())?.writeGrants ?? [];

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    for (const role of ["admin", "member", "viewer"] as const) {
      await User.create({ _id: role, email: `${role}@example.com` });
      await WorkspaceMember.create({
        workspaceId: WS,
        userId: role,
        role,
        joinedAt: new Date(),
      });
    }
    await Workspace.collection.insertOne({
      _id: WS,
      name: "t",
      slug: `t-${WS}`,
      createdBy: "admin",
      // Unscoped keys act as their creator, with the creator's role.
      apiKeys: Object.entries(KEYS).map(([role, value]) => ({
        _id: new Types.ObjectId(),
        name: role,
        keyHash: hashApiKey(value),
        prefix: value.slice(0, 14),
        createdAt: new Date(),
        createdBy: role,
      })),
    });
    for (const [_id, workspaceId] of [
      [CONN, WS],
      [FOREIGN_CONN, OTHER_WS],
    ]) {
      await DatabaseConnection.collection.insertOne({
        _id,
        workspaceId,
        name: "bigquery_write",
        type: "bigquery",
        connection: {},
        allowAgentWrites: false,
        createdBy: "admin",
      });
    }

    const grant = (principal: string, table = "*") => ({
      schema: "mako_app",
      table,
      principal,
    });

    // Members and viewers cannot change grants.
    assert.equal(
      (await put(KEYS.member, CONN, { grants: [grant("role:member")] })).status,
      403,
    );
    assert.equal(
      (await put(KEYS.viewer, CONN, { grants: [grant("role:member")] })).status,
      403,
    );
    assert.equal((await stored()).length, 0);

    // An admin can, and the grantor is recorded.
    const ok = await put(KEYS.admin, CONN, {
      grants: [grant("role:member"), grant("user:member", "quotas")],
    });
    assert.equal(ok.status, 200);
    const first = await stored();
    assert.deepEqual(
      first.map(g => [g.table, g.principal, g.grantedBy]),
      [
        ["*", "role:member", "admin"],
        ["quotas", "user:member", "admin"],
      ],
    );

    // Grants never flip allowAgentWrites.
    assert.equal(
      (await DatabaseConnection.findById(CONN).lean())?.allowAgentWrites,
      false,
    );

    // Unchanged grants keep their original timestamp; removed ones go.
    const again = await put(KEYS.admin, CONN, {
      grants: [grant("role:member"), grant("workflows", "labels")],
    });
    assert.equal(again.status, 200);
    const second = await stored();
    assert.deepEqual(
      second.map(g => [g.table, g.principal]),
      [
        ["*", "role:member"],
        ["labels", "workflows"],
      ],
    );
    assert.equal(
      new Date(second[0].grantedAt).getTime(),
      new Date(first[0].grantedAt).getTime(),
    );

    // Refused: a viewer or a stranger as user principal, malformed targets.
    for (const bad of [
      grant("user:viewer"),
      grant("user:stranger"),
      grant("role:viewer"),
      { schema: "*", table: "*", principal: "role:member" },
      { schema: "a.b", table: "c", principal: "role:member" },
    ]) {
      const res = await put(KEYS.admin, CONN, { grants: [bad] });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await stored()).length, 2, "a refusal changes nothing");

    // Another workspace's connection is not found.
    assert.equal(
      (await put(KEYS.admin, FOREIGN_CONN, { grants: [] })).status,
      404,
    );

    // Clearing works.
    assert.equal((await put(KEYS.admin, CONN, { grants: [] })).status, 200);
    assert.equal((await stored()).length, 0);
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().then(
  () => console.info("write-grants.db.test.ts: ok"),
  error => {
    console.error(error);
    process.exitCode = 1;
  },
);
