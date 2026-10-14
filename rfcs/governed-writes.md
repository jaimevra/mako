# RFC: Governed writes — apps and workflows writing to a customer's database

**Status:** draft
**Motivating cases:** sales quotas edited in an app, planning assumptions
edited in an app, LLM classification labels written by a scheduled workflow.

## The one primitive

> A write is a **parameterized SQL statement in git** that **declares its
> target table**, run by Mako against a **write-flagged connection** whose
> **allowlist contains that target**.

Everything else is a caller of that primitive. There are two callers: apps
(a person clicks save) and workflows (a job writes rows). Both go through the
same function and the same checks.

```sql
-- actions/set_quota.sql
-- connection: bigquery_write
-- writes: mako_app.quotas
-- allow: editor

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

## Three layers of "who may write where"

| Layer | Decided by | Where | Mechanism |
|---|---|---|---|
| Which tables | workspace admin | connection settings | `writableTargets` allowlist (new); the DB's own `GRANT` as a backstop |
| Which rows / columns | the author | the statement | `WHERE … = {{viewer.id}}`, column list in the SQL |
| Who may call it | the author | `-- allow:` | app role (apps); the workflow runtime (workflows) |

No new permission language. The admin lists targets, the SQL does the rest.

## Changes, by size

### 1. Connection: `writableTargets` (small)

`allowAgentWrites: boolean` stays as the switch. Add next to it:

```ts
writableTargets?: string[];   // e.g. ["mako_app.*", "analytics.ticket_labels"]
```

Flag on + empty list = no writes. Patterns are `schema.table` with `*`
allowed for the table part only (a dataset/schema is the natural grain).

### 2. One server function (small)

```ts
runGovernedWrite({ connectionId, statement, params, actor })
```

Checks, in order, each failing with a message that says why and how to fix it:

1. connection `allowAgentWrites` is on
2. statement declares `-- writes:`
3. declared target matches a `writableTargets` pattern
4. every table in a write position of the statement is the declared target
   (sanity check via the existing SQL parser; the declaration is the contract,
   not the parse)
5. actor is allowed: app role satisfies `-- allow:`, or actor is the
   workflow runtime
6. bind `:params` as driver parameters (never string-interpolated), fill
   `{{viewer.*}}` server-side
7. run through the existing driver with `readOnly: false`
8. append one audit row: actor, connection, target, statement sha, params, outcome

Front-matter parsing reuses `parseBindingFrontMatter` in
`api/src/apps/bindings.service.ts`; parameter binding reuses what the drivers
already accept.

### 3. Apps caller (medium)

- `actions/<name>.sql` in the app repo, alongside `bindings/`.
- `POST /apps/:id/actions/:name` with `{ params }`; session auth and app ACL
  exactly as `/apps/:id/live/*` today. Public share (anonymous viewer) → 403.
- SDK: `const setQuota = useAction("set_quota"); await setQuota({...})`.
- `-- refreshes: quotas` re-runs the named bindings after success so the app
  shows the new value without a reload.
- Publish includes actions at the published sha, same as bindings.

### 4. Workflows caller (small)

- `write(connection, sql, params)` in `deploy/workflows/runtime/defaults/lib/mako.ts`,
  next to `query()`. Same statement format, inline instead of a file.
- The worker key gains the `query:write` scope; it is already read-only unless
  the connection opts in, and now also unless the target is allowlisted.

## Explicitly not in this RFC

- **Table creation / migration.** The customer (or the agent, via a console on
  a write-flagged connection) creates tables. Mako writes into tables that exist.
- **Column-level grants in Mako.** Columns are decided in the statement; the DB
  can add column grants if wanted.
- **A policy language** (Cedar, OPA). Revisit only when a rule can't be
  expressed as `-- allow:` plus a `WHERE`.
- **Writes from public share links.**
- **A Mako-managed default database.** Pure BYOD; a workspace without a
  writable connection can't write.

## Acceptance

1. Quota saved in an app shows in the app at once and is queryable in the
   warehouse under `mako_app.quotas`.
2. A workflow classifies new tickets on a schedule and appends labels to
   `mako_app.ticket_labels`; re-runs don't duplicate.
3. A statement targeting a table outside `writableTargets` is refused before
   it reaches the database, with a message naming the allowlist.
4. A viewer without the `-- allow:` role gets 403; the UI can read the
   action's `allow` to hide the control.
5. A read-only app and every existing binding behave exactly as before.
