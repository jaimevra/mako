# RFC: Governed writes — apps and workflows writing to a customer's database

**Status:** draft — slice 1 (write grants: store, validate, display) implemented; see "Where this landed"
**Motivating cases:** sales quotas edited in an app, planning assumptions
edited in an app, LLM classification labels written by a scheduled workflow.

## The one primitive

> A write is a **parameterized SQL statement in git** whose target table is
> covered by a **write grant** on the connection for the person (or workflow)
> making it.

Everything else is a caller of that primitive. There are two callers: apps
(a person clicks save) and workflows (a job writes rows). Both go through the
same function and the same checks.

```sql
-- actions/set_quota.sql
-- connection: bigquery_write
-- writes: mako_app.quotas

MERGE mako_app.quotas q
USING (SELECT :rep_id AS rep_id, :quarter AS quarter, :amount AS amount) s
ON q.rep_id = s.rep_id AND q.quarter = s.quarter
WHEN MATCHED THEN UPDATE SET amount = s.amount,
  updated_by = {{viewer.email}}, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (rep_id, quarter, amount, updated_by, updated_at)
  VALUES (s.rep_id, s.quarter, s.amount, {{viewer.email}}, CURRENT_TIMESTAMP());
```

The caller supplies only `:param` values. `{{viewer.*}}` is filled in by the
server and can't be forged. The statement itself is reviewed code.

## Who may write where: write grants

One concept: a **grant** = who + may write + where, stored on the connection
in Mongo, edited by workspace owners/admins only, never in git.

```ts
writeGrants: [
  { schema: "mako_app", table: "*",             principal: "role:member" },
  { schema: "sales",    table: "quotas",        principal: "user:<id>"   },
  { schema: "mako_app", table: "ticket_labels", principal: "workflows"   },
]
```

- **Where:** a schema/dataset (`table: "*"`) or one table. Anything no grant
  covers is read-only for governed writes, whatever the credential can do —
  the second layer on top of the database's own GRANTs, which in practice
  are often "write everything".
- **Who:** only principals Mako already has — `role:member|admin|owner` (that
  workspace role or higher), `user:<id>`, `workflows`. Workspace viewers and
  anonymous share visitors never write, whatever a grant says.
- **Check:** `findWriteGrant(grants, actor, target)` — a grant matches or the
  write is refused. Names compare case-insensitively.
- Row rules (`WHERE rep_id = {{viewer.id}}`) stay in the statement: they can
  only narrow what a grant permits.

### Two rules that keep this from breaking anything

1. **Grants gate only the new governed paths** (app actions, workflow
   `write()`). Consoles, the in-product agent, legacy REST keys and
   `allowAgentWrites` MCP keys write exactly as today.
2. **Grants and `allowAgentWrites` are independent.** Adding a grant never
   flips the flag — otherwise a `query:write` MCP key would gain write access
   to every table on that connection, not just the granted one.

### Which tables does a statement write?

`writeTargets(sql)` (`api/src/services/write-grants.ts`) returns the
schema.table targets of one INSERT / UPDATE / DELETE / MERGE / REPLACE
(optionally behind WITH), and fails closed on everything else: DDL, scripts,
CALL/COPY/TRUNCATE, multiple statements, `SELECT … INTO`, multi-table
UPDATE/DELETE, unqualified targets, executable or dollar-quoted blocks.
Where engines lex differently (`--x`, `\'`), it takes the reading that
exposes more code, so the worst case is a refused write, never a hidden one.
It is a new function beside `checkPreviewQuerySafety`, which is unchanged.

Out of its scope: side-effecting function calls inside a statement
(`dblink_exec`, …). A connection whose credential can do that should not
carry grants.

Not a policy language. Later needs are optional fields on a grant with a
default meaning "as before": `actions: ["insert"]`, `group:<id>` principals,
a `condition` (at which point grants map 1:1 onto Cedar policies).

## Slices

### 1. Write grants — store, validate, display (implemented)

- `IDatabaseConnection.writeGrants` (`api/src/database/workspace-schema.ts`).
- `PUT /api/workspaces/:ws/databases/:id/write-grants` replaces the list;
  owners/admins only; validates shape and principals (a `user:` must be a
  non-viewer member); keeps `grantedBy`/`grantedAt` on unchanged grants.
  `GET /databases` returns `writeGrants` with each connection.
- `inspect_connection` returns the grants, so the agent knows where it may
  write before drafting anything.
- Database tree: a pencil badge on connections with grants and on each
  covered dataset/schema/table; right-click → **Write access…** (owners and
  admins) opens a dialog to add people, roles or Workflows, and shows
  schema-wide grants a table inherits. Grantable nodes: BigQuery datasets and
  tables, Postgres-family schemas and tables, MySQL/ClickHouse databases and
  tables.

### 2. `runGovernedWrite` (next)

```ts
runGovernedWrite({ connectionId, statement, params, actor })
```

1. `writeTargets(statement)` — refuse on error
2. every target covered by `findWriteGrant(grants, actor, target)`
3. bind `:params` as driver parameters (never interpolated), fill
   `{{viewer.*}}` server-side
4. run through the existing driver with `readOnly: false`
5. append one audit row: actor, connection, targets, statement sha, params,
   outcome

### 3. Apps caller

- `actions/<name>.sql` in the app repo, alongside `bindings/`
  (`-- connection:` front matter, parsed like bindings).
- `POST /apps/:id/actions/:name` with `{ params }`; session auth as
  `/apps/:id/live/*`. Public share (anonymous viewer) → 403.
- SDK: `const setQuota = useAction("set_quota"); await setQuota({...})`.
- `-- refreshes: quotas` re-runs the named bindings after success.

### 4. Workflows caller

- `write(connection, sql, params)` in
  `deploy/workflows/runtime/defaults/lib/mako.ts`, next to `query()`, acting
  as the `workflows` principal. `query()` stays read-only.

## Explicitly not in this RFC

- **Table creation / migration.** The customer (or the agent, via a console on
  a write-flagged connection) creates tables. Mako writes into tables that exist.
- **Column-level grants in Mako.** Columns are decided in the statement; the DB
  can add column grants if wanted.
- **A policy language** (Cedar, OPA). See above for how grants extend.
- **Gating consoles / the agent / existing keys with grants.** A separate
  decision; doing it here would refuse writes that work today.
- **Writes from public share links.**
- **A Mako-managed default database.** Pure BYOD; a workspace without a
  writable connection can't write.

## Acceptance

1. Quota saved in an app shows in the app at once and is queryable in the
   warehouse under `mako_app.quotas`.
2. A workflow classifies new tickets on a schedule and appends labels to
   `mako_app.ticket_labels`; re-runs don't duplicate.
3. A statement targeting a table no grant covers for that actor is refused
   before it reaches the database, with a message naming the grants.
4. A workspace viewer gets 403 on any action; anonymous share visitors too.
5. A read-only app and every existing binding behave exactly as before.

## Where this landed

Slice 1 is implemented: `api/src/services/write-grants.ts` (matcher +
statement scanner, tested in `write-grants.test.ts`), the grants endpoint
(tested against in-memory Mongo in `routes/write-grants.db.test.ts`),
`inspect_connection`, and the tree badge / menu / dialog
(`app/src/components/WriteAccessDialog.tsx`, `app/src/lib/write-grants.ts`).
Grants are stored and visible but nothing consults them yet: slices 2–4 are
the callers.
