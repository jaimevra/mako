/**
 * Every place that reads a database connection document directly, counted.
 *
 * A restricted connection may be used only by the people on its list
 * (access/connection-access.ts). Code that serves a person must obtain a
 * connection through the gate (`loadConnection`, `authorizeConnection`,
 * `accessDenial`, `usableConnections`), and `executeQuery` refuses one that
 * skipped it inside a person's request. This test is the tripwire for the
 * paths that never run a query (names and types for a list) or run as the
 * system: a new direct read anywhere fails here, so whoever adds one decides,
 * in review, which kind it is.
 *
 * To add one: gate it, or say below why it needs no gate, and update the
 * count.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

/** file → direct reads, and why each file's reads are allowed. */
const EXPECTED: Record<string, { count: number; why: string }> = {
  "access/connection-access.ts": { count: 1, why: "the gate itself" },

  // Gated right after the read (authorizeConnection / accessDenial /
  // usableConnections / denyConnection).
  "routes/workspace-databases.ts": { count: 16, why: "gated" },
  "routes/database-tree.ts": { count: 5, why: "gated" },
  "routes/notebook-data.ts": { count: 2, why: "gated" },
  "routes/agent.routes.ts": { count: 1, why: "list, filtered" },
  "agent-lib/tools/sql-tools.ts": { count: 2, why: "gated" },
  "agent-lib/tools/shared/database-discovery.ts": { count: 2, why: "gated" },
  "agent-lib/tools/mongodb-tools.ts": { count: 5, why: "gated" },
  "agent-lib/tools/server-notebook-tools.ts": { count: 1, why: "gated" },
  "agent-lib/tools/universal-tools.ts": { count: 1, why: "list, filtered" },
  "agent-lib/tools/connector-tools.ts": { count: 1, why: "gated" },
  "agents/flow/index.ts": { count: 2, why: "gated" },
  "apps/bindings.service.ts": { count: 1, why: "gated as the builder" },
  "services/console-execution.service.ts": { count: 1, why: "gated" },
  "inngest/functions/scheduled-query.ts": {
    count: 1,
    why: "gated as the console's owner",
  },
  "routes/consoles.ts": {
    count: 6,
    why: "execute and export gated; the rest read name and type only",
  },
  "routes/flows.ts": {
    count: 13,
    why: "create, edit, resets and previews gated; the rest read type only",
  },

  // Name or type only: no query runs on what they read.
  "agent-lib/tools/console-search-tools.ts": { count: 1, why: "names" },
  "agent-lib/tools/dbt-tools.ts": { count: 1, why: "type" },
  "agent-lib/tools/discovery-tools.ts": { count: 1, why: "type" },
  "agent-lib/tools/server-console-tools.ts": { count: 3, why: "type, name" },
  "agent-lib/tools/shared/binding-query-access.ts": { count: 1, why: "type" },
  "routes/dbt.routes.ts": { count: 1, why: "type" },

  // The system's: run outside any person's request, after a person who may
  // use the connection set them up (flows are checked when created or
  // edited). dbt is out of scope (rfcs/data-source-access.md).
  "dbt/dbt-project.service.ts": { count: 1, why: "dbt, marked system" },
  "services/dashboard-artifact-rebuild.service.ts": {
    count: 1,
    why: "background refresh, marked system",
  },
  "services/destination-writer.service.ts": { count: 2, why: "flow runs" },
  "services/flow-identity.service.ts": { count: 3, why: "flow runs" },
  "services/flow-run-notification.service.ts": { count: 3, why: "flow runs" },
  "inngest/functions/flow.ts": { count: 8, why: "flow runs" },
  "inngest/functions/webhook-flow.ts": { count: 1, why: "flow runs" },
  "sync/query-runner.ts": { count: 5, why: "flow runs" },
  "sync/sync-orchestrator.ts": { count: 3, why: "flow runs" },
  "sync-cdc/backfill.ts": { count: 4, why: "CDC" },
  "sync-cdc/consumer.ts": { count: 1, why: "CDC" },
  "sync-cdc/adapters/bigquery.ts": { count: 1, why: "CDC" },
  "sync-cdc/adapters/clickhouse.ts": { count: 1, why: "CDC" },
  "sync-cdc/adapters/mongodb.ts": { count: 1, why: "CDC" },
  "sync-cdc/adapters/mysql.ts": { count: 2, why: "CDC" },
  "sync-cdc/adapters/postgresql.ts": { count: 2, why: "CDC" },
  "scripts/backfill-console-descriptions.ts": { count: 1, why: "script" },
  "scripts/migrate-legacy-flows-to-cdc.ts": { count: 1, why: "script" },
  "scripts/seed-dev-admin.ts": { count: 1, why: "script" },
};

const READ = /DatabaseConnection\.(find|findOne|findById)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

const actual: Record<string, number> = {};
for (const path of sourceFiles(SRC)) {
  // Read as latin1: some sources hold a NUL byte, and a text search that
  // treats them as binary would miss their reads.
  const count = readFileSync(path, "latin1").match(READ)?.length ?? 0;
  if (count) actual[relative(SRC, path)] = count;
}

for (const [file, count] of Object.entries(actual)) {
  const expected = EXPECTED[file];
  assert.ok(
    expected,
    `${file} reads connections directly (${count}x) and is not listed: gate it ` +
      "through access/connection-access.ts, or list it here with the reason " +
      "it needs no gate",
  );
  assert.equal(
    count,
    expected.count,
    `${file} now reads connections directly ${count}x, not ${expected.count}: ` +
      "gate the new read, or update the count with the reason",
  );
}
for (const file of Object.keys(EXPECTED)) {
  assert.ok(actual[file], `${file} no longer reads connections: remove it`);
}

console.log("connection lookup guard passed");
