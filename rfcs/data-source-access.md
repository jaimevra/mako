# RFC: Who may use a data source

Status: step 1 implemented (connection level). Step 2 (schema and table
scopes) open.

## Problem

Every workspace member can query every connection, schema, table and
column. RealAdvisor has 1 owner, 9 admins and 19 members, and admins can
make more admins, so "admins only" is no gate for sensitive data such as
finance.

## Step 1: a connection is open or restricted

The same sharing idea consoles, dashboards and apps already use, applied to
database connections.

```ts
// on DatabaseConnection
access?: {
  restricted: boolean;
  entries: { principal: "user:<id>"; level: "read" | "write" | "manage" }[];
  updatedBy, updatedAt;
}
```

- **Open** (absent, or `restricted: false`): anyone in the workspace, exactly
  as before. Every existing connection stays open; nothing is migrated.
- **Restricted**: only the workspace owner and the people listed.
  - `read`: queries run read-only.
  - `write`: any statement the credential allows, creating tables included.
  - `manage`: write, plus changing the list, the credentials, or deleting it.
- **Admins get nothing special on a restricted connection.** The owner
  always manages.
- **Restricting** an open connection: the owner or an admin (the people who
  may delete a connection today; restricting only takes access away).
  Whoever restricts it is added as a manager.
- **Changing the list**: in the app only (a session), never with an API key,
  MCP client or agent.
- `principal` is a string so `app:`, `workflow:` and `group:` fit later
  without a migration. Step 1 lists people only.

### Who acts

| Path | Acts as |
|---|---|
| Console, notebook, schema tree, REST, agent, MCP | the signed-in person (or the API key's owner) |
| Scheduled console | the console's owner |
| App binding | whoever builds it (editor, publisher); the app's owner for an unattended refresh |
| Workflow step | the worker key's owner, through MCP |
| Flow | checked when a person creates or edits it (read on the source, write on the destination); runs as the system |
| dbt, dashboard refresh, sync, CDC | the system (dbt is out of scope) |

### Enforcement

1. **The gate**, `api/src/access/connection-access.ts`: `loadConnection`,
   `authorizeConnection`, `accessDenial`, `usableConnections`. Checks the
   person's level and marks the connection document it returns.
2. **The second check**, in `executeQuery` and `getConnection`: inside a
   person's request, a restricted connection without that mark is refused,
   and a `read` grant forces read-only. Work outside any request (sync, CDC,
   scheduled runs) is the system's.
3. **Lists hide** restricted connections from people not on them: the
   connection list, the agent's listing tools, the agent's prompt context,
   notebooks.
4. **Guard test**, `access/connection-lookups.test.ts`: every direct read of
   a connection document is counted per file, with the reason it needs no
   gate (names and types only, or system). A new read fails the build until
   someone gates it or explains it.
5. **Route test**, `access/connection-access.db.test.ts`: the owner, an
   admin, a listed reader and an unlisted member against the real routes.

### What it does not stop

- Outputs someone with access shares: a dashboard, an app, an export.
- dbt, which runs with the connection's own credentials.
- Anything the warehouse credential itself allows. For data that must stay
  secret, give it its own connection with its own service account, restrict
  that connection, and remove the data from the other connections' service
  accounts. Then the warehouse enforces it too.

## Step 2, if needed: schema and table scopes

A list entry gains an optional scope (`schemas`, `tables`). Entries without
one keep meaning the whole connection. Enforcement asks the database which
tables a statement touches (BigQuery dry run, Postgres `EXPLAIN`) instead of
parsing SQL, and refuses user-defined routines on scoped connections. Build
it only when one connection per sensitivity level is not enough.
