/**
 * Restricted connections through the real routes, against an in-memory
 * Mongo, as four people: the owner, an admin, a member on the list with read
 * access, and a member who is not on it. An open connection stays exactly as
 * before for all four.
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
import { workspaceDatabaseRoutes } from "../routes/workspace-databases";
import { databaseTreeRoutes } from "../routes/database-tree";

const PEOPLE = {
  owner: "owner",
  admin: "admin",
  reader: "reader",
  stranger: "stranger",
} as const;
type Person = keyof typeof PEOPLE;
const ROLE: Record<Person, string> = {
  owner: "owner",
  admin: "admin",
  reader: "member",
  stranger: "member",
};
const keyOf = (person: Person) => `revops_key_for_${person}_tests_only`;

const app = new OpenAPIHono();
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
app.route("/api/workspaces/:workspaceId/databases", databaseTreeRoutes);

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  try {
    const ws = new Types.ObjectId();
    for (const person of Object.keys(PEOPLE) as Person[]) {
      await User.create({ _id: person, email: `${person}@example.com` });
      await WorkspaceMember.create({
        workspaceId: ws,
        userId: person,
        role: ROLE[person],
        joinedAt: new Date(),
      });
    }
    await Workspace.collection.insertOne({
      _id: ws,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "owner",
      // Unscoped keys, so each person can call the REST routes as themselves.
      apiKeys: (Object.keys(PEOPLE) as Person[]).map(person => ({
        _id: new Types.ObjectId(),
        name: person,
        keyHash: hashApiKey(keyOf(person)),
        prefix: keyOf(person).slice(0, 14),
        createdAt: new Date(),
        createdBy: person,
      })),
    });
    const connection = (name: string, access?: unknown) =>
      DatabaseConnection.create({
        workspaceId: ws,
        name,
        type: "postgresql",
        connection: { host: "127.0.0.1", port: 1, database: "none" },
        createdBy: "owner",
        ...(access ? { access } : {}),
      });
    const open = await connection("open");
    const finance = await connection("finance", {
      restricted: true,
      entries: [{ principal: "user:reader", level: "read" }],
    });

    const call = (
      person: Person,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      app.request(`/api/workspaces/${ws}/databases${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${keyOf(person)}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const listed = async (person: Person) => {
      const res = await call(person, "GET", "");
      assert.equal(res.status, 200);
      const json = (await res.json()) as { data: { name: string }[] };
      return json.data.map(d => d.name).sort();
    };

    // The list: only people allowed see the restricted connection.
    assert.deepEqual(await listed("owner"), ["finance", "open"]);
    assert.deepEqual(await listed("reader"), ["finance", "open"]);
    assert.deepEqual(await listed("admin"), ["open"]);
    assert.deepEqual(await listed("stranger"), ["open"]);

    // Every route on the restricted connection refuses the people not on it.
    const restrictedRoutes: Array<[string, string, unknown?]> = [
      ["GET", `/${finance._id}`],
      ["GET", `/${finance._id}/access`],
      ["GET", `/${finance._id}/tree`],
      ["GET", `/${finance._id}/autocomplete`],
      ["POST", `/${finance._id}/test`, {}],
      ["POST", `/${finance._id}/execute`, { query: "select 1" }],
      ["GET", `/${finance._id}/collections`],
      ["GET", `/${finance._id}/views`],
    ];
    for (const person of ["admin", "stranger"] as const) {
      for (const [method, path, body] of restrictedRoutes) {
        const res = await call(person, method, path, body);
        assert.equal(res.status, 403, `${person} ${method} ${path}`);
      }
    }

    // The reader may look, at read level, and cannot change the list.
    const readerView = await call("reader", "GET", `/${finance._id}/access`);
    assert.equal(readerView.status, 200);
    const view = (await readerView.json()) as {
      data: { restricted: boolean; level: string; canManage: boolean };
    };
    assert.equal(view.data.restricted, true);
    assert.equal(view.data.level, "read");
    assert.equal(view.data.canManage, false);

    // A read grant runs read-only: creating a table is refused before the
    // database is ever reached.
    const create = await call("reader", "POST", `/${finance._id}/execute`, {
      query: "create table finance.copy as select * from finance.invoices",
    });
    assert.notEqual(create.status, 403);
    const created = (await create.json()) as {
      success: boolean;
      error?: string;
    };
    assert.equal(created.success, false);
    assert.match(String(created.error), /read|write|not allowed|permitted/i);

    // Editing and deleting a restricted connection: not for admins.
    assert.equal(
      (await call("admin", "PUT", `/${finance._id}`, { name: "renamed" }))
        .status,
      403,
    );
    assert.equal(
      (await call("admin", "DELETE", `/${finance._id}`)).status,
      403,
    );
    assert.equal(
      (await DatabaseConnection.findById(finance._id).lean())?.name,
      "finance",
    );

    // Access is changed in the app, never with an API key, even the owner's.
    const byKey = await call("owner", "PUT", `/${finance._id}/access`, {
      restricted: false,
      entries: [],
    });
    assert.equal(byKey.status, 403);

    // The open connection is unchanged for everyone.
    for (const person of Object.keys(PEOPLE) as Person[]) {
      const res = await call(person, "GET", `/${open._id}/access`);
      assert.equal(res.status, 200, person);
      const json = (await res.json()) as {
        data: { restricted: boolean; level: string; canManage: boolean };
      };
      assert.equal(json.data.restricted, false);
      assert.equal(json.data.level, "write");
      // Restricting it: owner and admins, as deleting it is today.
      assert.equal(
        json.data.canManage,
        person === "owner" || person === "admin",
      );
    }

    console.log("connection access route tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
