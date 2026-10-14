import assert from "node:assert/strict";

import {
  findWriteGrant,
  writeGrantProblem,
  writeTargets,
  type WriteActor,
  type WriteGrant,
} from "./write-grants";

/**
 * Write grants decide which tables a governed write may touch. Every
 * assertion here is about failing closed: a missed target or a too-generous
 * match is a write nobody granted.
 */

// --- matching ---------------------------------------------------------------

const grants: WriteGrant[] = [
  { schema: "mako_app", table: "*", principal: "role:member" },
  { schema: "finance", table: "assumptions", principal: "role:admin" },
  { schema: "sales", table: "quotas", principal: "user:alice" },
  { schema: "mako_app", table: "ticket_labels", principal: "workflows" },
];

const member: WriteActor = { kind: "user", userId: "bob", role: "member" };
const admin: WriteActor = { kind: "user", userId: "carol", role: "admin" };
const alice: WriteActor = { kind: "user", userId: "alice", role: "member" };
const viewer: WriteActor = { kind: "user", userId: "alice", role: "viewer" };
const workflows: WriteActor = { kind: "workflows" };

const t = (schema: string, table: string) => ({ schema, table });

// A schema-wide grant covers every table in it, for that role and above.
assert.ok(findWriteGrant(grants, member, t("mako_app", "anything")));
assert.ok(findWriteGrant(grants, admin, t("mako_app", "anything")));
// …and nothing outside it.
assert.equal(findWriteGrant(grants, member, t("analytics", "deals")), null);

// Role rank: admin-only grant refuses a member, accepts an admin.
assert.equal(findWriteGrant(grants, member, t("finance", "assumptions")), null);
assert.ok(findWriteGrant(grants, admin, t("finance", "assumptions")));

// A user grant names exactly one user.
assert.ok(findWriteGrant(grants, alice, t("sales", "quotas")));
assert.equal(findWriteGrant(grants, member, t("sales", "quotas")), null);

// A table grant does not leak to sibling tables.
assert.equal(findWriteGrant(grants, alice, t("sales", "deals")), null);

// Workspace viewers never write, even when a user grant names them.
assert.equal(findWriteGrant(grants, viewer, t("sales", "quotas")), null);
assert.equal(findWriteGrant(grants, viewer, t("mako_app", "x")), null);

// Workflows match only the workflows principal, and people never match it.
assert.ok(findWriteGrant(grants, workflows, t("mako_app", "ticket_labels")));
assert.equal(findWriteGrant(grants, workflows, t("sales", "quotas")), null);
assert.equal(
  findWriteGrant(
    [{ schema: "x", table: "y", principal: "workflows" }],
    admin,
    t("x", "y"),
  ),
  null,
);

// Names compare case-insensitively.
assert.ok(findWriteGrant(grants, alice, t("SALES", "Quotas")));

// No grants, malformed principal: refuse.
assert.equal(findWriteGrant(undefined, admin, t("a", "b")), null);
assert.equal(
  findWriteGrant(
    [{ schema: "a", table: "*", principal: "role:viewer" }],
    admin,
    t("a", "b"),
  ),
  null,
);

// --- grant validation -------------------------------------------------------

assert.equal(
  writeGrantProblem({ schema: "a", table: "*", principal: "role:member" }),
  null,
);
assert.equal(
  writeGrantProblem({ schema: "a", table: "b", principal: "user:65f0a1" }),
  null,
);
assert.ok(
  writeGrantProblem({ schema: "*", table: "*", principal: "role:member" }),
);
assert.ok(
  writeGrantProblem({ schema: "a.b", table: "c", principal: "role:member" }),
);
assert.ok(
  writeGrantProblem({ schema: "a", table: "b c", principal: "role:member" }),
);
assert.ok(
  writeGrantProblem({ schema: "a", table: "b", principal: "role:viewer" }),
);
assert.ok(
  writeGrantProblem({ schema: "a", table: "b", principal: "everyone" }),
);

// --- which tables a statement writes ----------------------------------------

function targetsOf(sql: string): string[] {
  const r = writeTargets(sql);
  assert.ok(
    "targets" in r,
    `expected targets for: ${sql}\n got: ${JSON.stringify(r)}`,
  );
  return r.targets.map(x => `${x.schema}.${x.table}`);
}
function refused(sql: string): void {
  const r = writeTargets(sql);
  assert.ok(
    "error" in r,
    `expected refusal for: ${sql}\n got: ${JSON.stringify(r)}`,
  );
}

assert.deepEqual(
  targetsOf("INSERT INTO mako_app.labels (id, label) VALUES (:id, :label)"),
  ["mako_app.labels"],
);
assert.deepEqual(
  targetsOf("UPDATE sales.quotas SET amount = :a WHERE rep_id = :r;"),
  ["sales.quotas"],
);
assert.deepEqual(targetsOf("DELETE FROM sales.quotas WHERE rep_id = :r"), [
  "sales.quotas",
]);
assert.deepEqual(targetsOf("delete sales.quotas where true"), ["sales.quotas"]);
assert.deepEqual(targetsOf("INSERT IGNORE INTO `sales`.`quotas` VALUES (1)"), [
  "sales.quotas",
]);
assert.deepEqual(targetsOf('UPDATE ONLY "sales"."quotas" SET a = 1'), [
  "sales.quotas",
]);

// BigQuery: project prefix dropped, whole path in one pair of backticks.
assert.deepEqual(
  targetsOf("INSERT INTO `my-proj.mako_app.labels` (a) VALUES (1)"),
  ["mako_app.labels"],
);
assert.deepEqual(
  targetsOf("INSERT INTO my-proj.mako_app.labels (a) VALUES (1)"),
  ["mako_app.labels"],
);

// MERGE: the inner UPDATE SET / INSERT (…) / DELETE name no extra table.
assert.deepEqual(
  targetsOf(`MERGE mako_app.quotas q
    USING (SELECT :rep AS rep) s ON q.rep = s.rep
    WHEN MATCHED THEN UPDATE SET amount = 1
    WHEN NOT MATCHED BY SOURCE THEN DELETE
    WHEN NOT MATCHED THEN INSERT (rep) VALUES (s.rep)`),
  ["mako_app.quotas"],
);
assert.deepEqual(
  targetsOf(
    "MERGE INTO a.b USING c.d ON true WHEN NOT MATCHED THEN INSERT ROW",
  ),
  ["a.b"],
);

// Upserts.
assert.deepEqual(
  targetsOf(
    "INSERT INTO a.b (k, v) VALUES (1, 2) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
  ),
  ["a.b"],
);
assert.deepEqual(
  targetsOf(
    "INSERT INTO a.b (k, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = VALUES(v)",
  ),
  ["a.b"],
);

// Postgres data-modifying CTE: both tables count.
assert.deepEqual(
  targetsOf(
    "WITH moved AS (DELETE FROM a.old RETURNING *) INSERT INTO a.new SELECT * FROM moved",
  ),
  ["a.old", "a.new"],
);

// Reading another table is fine; only the written one is a target.
assert.deepEqual(
  targetsOf("INSERT INTO a.b SELECT * FROM analytics.deals FOR UPDATE"),
  ["a.b"],
);
// REPLACE() the function is not REPLACE INTO.
assert.deepEqual(targetsOf("UPDATE a.b SET name = REPLACE(name, 'x', 'y')"), [
  "a.b",
]);

// Keywords inside strings and comments are not code.
assert.deepEqual(
  targetsOf("UPDATE a.b SET note = 'DELETE FROM x.y; it''s fine' -- DROP x\n"),
  ["a.b"],
);
assert.deepEqual(targetsOf("/* INSERT INTO z.z */ UPDATE a.b SET v = 1"), [
  "a.b",
]);

// Refusals: not DML, not one statement, not attributable.
refused("SELECT * FROM a.b");
refused("CREATE TABLE a.b (x int)");
refused("DROP TABLE a.b");
refused("TRUNCATE a.b");
refused("CALL a.proc()");
refused("COPY a.b FROM '/etc/passwd'");
refused("DO $$ BEGIN DELETE FROM a.b; END $$");
refused("UPDATE a.b SET v = 1; DELETE FROM c.d");
refused("INSERT INTO quotas VALUES (1)"); // unqualified
refused("UPDATE a.b JOIN c.d ON true SET a.b.v = 1");
refused("UPDATE a.b, c.d SET v = 1");
refused("DELETE a.t1, a.t2 FROM a.t1 JOIN a.t2 ON true");
refused("INSERT INTO a.b SELECT * INTO OUTFILE '/tmp/x' FROM c.d");
refused("WITH x AS (SELECT 1) SELECT * INTO a.new FROM x");
refused("/*! DELETE FROM a.b */ UPDATE a.b SET v = 1");
refused("UPDATE a.b SET v = 'unterminated");
refused("UPDATE a.b SET v = 1 /* unterminated");

// Where engines lex differently, the scan sees MORE code, never less.
// Postgres: `\'` does not escape, so the DELETE is live code there.
refused("UPDATE a.b SET v = 'x\\' ; DELETE FROM c.d; --'");
// MySQL: `--x` is not a comment, so the semicolon after it is live code.
refused("UPDATE a.b SET v = 1 --1; DELETE FROM c.d");

console.info("write-grants.test.ts: ok");
