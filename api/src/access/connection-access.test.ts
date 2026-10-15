/**
 * Who may use a connection, without a database: the level each person gets,
 * who may change the list, and the second check where a query runs.
 */
import assert from "node:assert/strict";
import {
  ConnectionAccessError,
  asSystemConnection,
  assertMayQuery,
  authorizeConnection,
  canManageConnectionAccess,
  connectionLevel,
} from "./connection-access";
import { requestContextStorage } from "../logging/context";

const open = { access: undefined };
const restricted = {
  access: {
    restricted: true,
    entries: [
      { principal: "user:reader", level: "read" as const },
      { principal: "user:writer", level: "write" as const },
      { principal: "user:manager", level: "manage" as const },
    ],
  },
};

// An open connection is unchanged: everyone in the workspace, as before.
for (const role of ["owner", "admin", "member", "viewer", undefined]) {
  assert.equal(connectionLevel(open, "anyone", role), "write");
}

// Restricted: the list decides, the owner manages, admins get nothing.
assert.equal(connectionLevel(restricted, "reader", "member"), "read");
assert.equal(connectionLevel(restricted, "writer", "member"), "write");
assert.equal(connectionLevel(restricted, "manager", "member"), "manage");
assert.equal(connectionLevel(restricted, "boss", "owner"), "manage");
assert.equal(connectionLevel(restricted, "someone", "admin"), null);
assert.equal(connectionLevel(restricted, "someone", "member"), null);
assert.equal(connectionLevel(restricted, undefined, undefined), null);

// Who changes the list: to restrict an open connection, the owner or an
// admin; once restricted, its managers and the owner only.
assert.equal(canManageConnectionAccess(open, "a", "admin"), true);
assert.equal(canManageConnectionAccess(open, "o", "owner"), true);
assert.equal(canManageConnectionAccess(open, "m", "member"), false);
assert.equal(canManageConnectionAccess(restricted, "a", "admin"), false);
assert.equal(canManageConnectionAccess(restricted, "writer", "member"), false);
assert.equal(canManageConnectionAccess(restricted, "manager", "member"), true);
assert.equal(canManageConnectionAccess(restricted, "o", "owner"), true);

// The second check, where a query runs.
const inRequest = <T>(fn: () => T): T =>
  requestContextStorage.run({ requestId: "r", userId: "someone" } as never, fn);

// Open connections pass untouched, in or out of a request.
assert.equal(assertMayQuery({ ...open }, false), false);
assert.equal(
  inRequest(() => assertMayQuery({ ...open }, undefined)),
  undefined,
);

// A restricted connection that skipped the gate is refused inside a request…
assert.throws(
  () => inRequest(() => assertMayQuery({ ...restricted }, false)),
  /did not come through its access check/,
);
// …and is the system's outside one (sync, CDC, scheduled runs).
assert.equal(assertMayQuery({ ...restricted }, false), false);
// A job inside a request that acts for nobody says so.
assert.equal(
  inRequest(() => assertMayQuery(asSystemConnection({ ...restricted }), false)),
  false,
);

// The mark survives a copy.
const marked = asSystemConnection({ ...restricted });
assert.equal(
  inRequest(() => assertMayQuery({ ...marked }, false)),
  false,
);

async function gate() {
  const as = (userId: string, need?: "read" | "write" | "manage") =>
    authorizeConnection(
      { ...restricted },
      { workspaceId: "w", userId, memberRole: "member", need },
    );
  // A read grant forces the query read-only, even when asked to write.
  const reader = await as("reader");
  assert.equal(
    inRequest(() => assertMayQuery(reader, false)),
    true,
  );
  // A write grant leaves the statement as asked: creating tables included.
  const writer = await as("writer", "write");
  assert.equal(
    inRequest(() => assertMayQuery(writer, false)),
    false,
  );
  // Below the level needed, or not listed: refused.
  await assert.rejects(as("reader", "write"), ConnectionAccessError);
  await assert.rejects(as("writer", "manage"), ConnectionAccessError);
  await assert.rejects(as("stranger"), ConnectionAccessError);
  // Open connections need no lookup at all.
  const openDoc = await authorizeConnection(
    { ...open },
    { workspaceId: "w", userId: undefined },
  );
  assert.equal(assertMayQuery(openDoc, undefined), undefined);
}

gate().then(
  () => console.log("connection access tests passed"),
  error => {
    console.error(error);
    process.exitCode = 1;
  },
);
