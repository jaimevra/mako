/**
 * Write grants: who may write where, on one database connection.
 *
 * A grant is (principal, target). A target is a schema/dataset/database
 * (`table: "*"`) or one table in it. Anything no grant covers is read-only for
 * the governed write paths (app actions, workflow writes), whatever the
 * connection's credential could do. See rfcs/governed-writes.md.
 *
 * Grants deliberately do NOT gate the paths that write today — consoles, the
 * in-product agent, `allowAgentWrites` MCP keys. They gate only callers that
 * opt in by calling `findWriteGrant` / `writeTargets`.
 *
 * Pure: no Mongoose, no drivers, so it is unit-tested in isolation.
 */

export const WORKSPACE_ROLE_RANK = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
} as const;
export type WorkspaceRole = keyof typeof WORKSPACE_ROLE_RANK;

/** `role:<member|admin|owner>` (that role or higher), `user:<id>`, `workflows`. */
export type WriteGrantPrincipal =
  | { kind: "role"; role: Exclude<WorkspaceRole, "viewer"> }
  | { kind: "user"; userId: string }
  | { kind: "workflows" };

export interface WriteGrant {
  schema: string;
  /** A table name, or "*" for every table in `schema`. */
  table: string;
  principal: string;
}

export interface WriteTarget {
  schema: string;
  table: string;
}

/** Who is attempting a governed write. */
export type WriteActor =
  { kind: "user"; userId: string; role: WorkspaceRole } | { kind: "workflows" };

export function parseWriteGrantPrincipal(
  value: string,
): WriteGrantPrincipal | null {
  if (value === "workflows") return { kind: "workflows" };
  const colon = value.indexOf(":");
  const prefix = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (
    prefix === "role" &&
    (rest === "member" || rest === "admin" || rest === "owner")
  ) {
    return { kind: "role", role: rest };
  }
  if (prefix === "user" && /^[A-Za-z0-9_-]+$/.test(rest)) {
    return { kind: "user", userId: rest };
  }
  return null;
}

/** A grant names one identifier per part: no dots, no quotes, no blanks. */
const GRANT_NAME = /^[^\s."'`[\]]+$/;

/** Why a grant is malformed, or null when it is well-formed. */
export function writeGrantProblem(grant: WriteGrant): string | null {
  if (!GRANT_NAME.test(grant.schema) || grant.schema === "*") {
    return `Invalid schema "${grant.schema}": name one schema or dataset.`;
  }
  if (grant.table !== "*" && !GRANT_NAME.test(grant.table)) {
    return `Invalid table "${grant.table}": name one table, or "*".`;
  }
  if (!parseWriteGrantPrincipal(grant.principal)) {
    return (
      `Invalid principal "${grant.principal}": use role:member, ` +
      `role:admin, role:owner, user:<id> or workflows.`
    );
  }
  return null;
}

// Identifiers compare case-insensitively: the engines Mako writes to either
// fold unquoted names (Postgres, Snowflake-style) or treat table names
// case-insensitively (BigQuery), so an exact match would refuse writes the
// author obviously meant.
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function principalCovers(
  principal: WriteGrantPrincipal,
  actor: WriteActor,
): boolean {
  if (principal.kind === "workflows") return actor.kind === "workflows";
  if (actor.kind !== "user") return false;
  if (principal.kind === "user") return principal.userId === actor.userId;
  return WORKSPACE_ROLE_RANK[actor.role] >= WORKSPACE_ROLE_RANK[principal.role];
}

export function grantCoversTarget(
  grant: WriteGrant,
  target: WriteTarget,
): boolean {
  return (
    sameName(grant.schema, target.schema) &&
    (grant.table === "*" || sameName(grant.table, target.table))
  );
}

/** The grant that lets `actor` write `target`, or null (refuse). */
export function findWriteGrant(
  grants: readonly WriteGrant[] | undefined,
  actor: WriteActor,
  target: WriteTarget,
): WriteGrant | null {
  // Workspace viewers never write, whatever a grant names.
  if (actor.kind === "user" && actor.role === "viewer") return null;
  for (const grant of grants ?? []) {
    const principal = parseWriteGrantPrincipal(grant.principal);
    if (
      principal &&
      principalCovers(principal, actor) &&
      grantCoversTarget(grant, target)
    ) {
      return grant;
    }
  }
  return null;
}

// ── Which tables does a statement write? ──────────────────────────
//
// Fail closed: anything this cannot account for is an error, never an empty
// target list. Where engines disagree on lexing (`--x`, `\'`, `#`), the
// tokenizer takes the reading that exposes MORE code, so the worst case is a
// refused write, never a hidden one.
//
// Scope: which tables a DML statement targets. A side-effecting function
// call inside it (dblink_exec, …) is not a table target; a connection whose
// credential can do that should not carry grants.

type Token = { type: "word" | "ident" | "punct"; value: string };

function tokenize(sql: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (
      c === "-" &&
      sql[i + 1] === "-" &&
      /\s|^$/.test(sql[i + 2] ?? "")
    ) {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      // MySQL runs `/*! … */` as code.
      if (sql[i + 2] === "!") {
        return "Executable comments (/*! */) are not allowed.";
      }
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return "Unterminated block comment.";
      i = end + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) {
        j += sql[j] === "'" ? 2 : 1;
      }
      if (j >= sql.length) return "Unterminated string literal.";
      tokens.push({ type: "punct", value: "'" });
      i = j + 1;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      return "Dollar-quoted blocks are not allowed.";
    } else if (c === '"' || c === "`") {
      const end = sql.indexOf(c, i + 1);
      if (end === -1) return "Unterminated quoted identifier.";
      tokens.push({ type: "ident", value: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      // A hyphen joins a word only inside BigQuery project ids (my-proj.ds.t).
      while (
        /[A-Za-z0-9_$]/.test(sql[j] ?? "") ||
        (sql[j] === "-" && /[A-Za-z0-9]/.test(sql[j + 1] ?? ""))
      ) {
        j++;
      }
      tokens.push({ type: "word", value: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ type: "punct", value: c });
      i++;
    }
  }
  return tokens;
}

const WRITE_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "REPLACE",
]);

/** Words that may sit between a write keyword and its table. */
const MODIFIERS = new Set([
  "INTO",
  "FROM",
  "ONLY",
  "IGNORE",
  "LOW_PRIORITY",
  "DELAYED",
  "HIGH_PRIORITY",
  "QUICK",
]);

/** After these a write keyword names no table (`DO UPDATE SET`, `FOR UPDATE OF`). */
const NOT_A_TABLE = new Set([
  "SET",
  "VALUES",
  "ROW",
  "WHEN",
  "WHERE",
  "DEFAULT",
  "SELECT",
  "WITH",
  "OF",
  "NOWAIT",
  "SKIP",
]);

const JOIN_WORDS = new Set([
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "CROSS",
  "STRAIGHT_JOIN",
]);

const upper = (t: Token | undefined) =>
  t?.type === "word" ? t.value.toUpperCase() : "";

/**
 * The tables `sql` writes to, as schema.table (a BigQuery `project.` prefix
 * is dropped). Errors unless the statement is one plain INSERT / UPDATE /
 * DELETE / MERGE / REPLACE (optionally behind WITH) on schema-qualified
 * tables.
 */
export function writeTargets(
  sql: string,
): { targets: WriteTarget[] } | { error: string } {
  const tokens = tokenize(sql);
  if (typeof tokens === "string") return { error: tokens };
  if (tokens.at(-1)?.value === ";") tokens.pop();
  if (tokens.some(t => t.value === ";")) {
    return { error: "A write must be a single statement." };
  }
  // DDL, scripting, CALL, COPY, TRUNCATE… all start with something else.
  if (!WRITE_KEYWORDS.has(upper(tokens[0])) && upper(tokens[0]) !== "WITH") {
    return {
      error: "A write must be an INSERT, UPDATE, DELETE or MERGE statement.",
    };
  }

  const targets: WriteTarget[] = [];
  const consumedInto = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const word = upper(tokens[i]);
    if (word === "INTO" && !consumedInto.has(i)) {
      // SELECT … INTO new_table / INTO OUTFILE: creates or exports.
      return { error: "SELECT … INTO is not allowed in a governed write." };
    }
    if (!WRITE_KEYWORDS.has(word)) continue;
    if (upper(tokens[i - 1]) === "KEY") continue; // ON DUPLICATE KEY UPDATE col = …

    let j = i + 1;
    while (MODIFIERS.has(upper(tokens[j]))) {
      if (upper(tokens[j]) === "INTO") consumedInto.add(j);
      j++;
    }
    const first = tokens[j];
    if (!first || first.type === "punct" || NOT_A_TABLE.has(upper(first))) {
      continue;
    }

    const parts = [first.value];
    while (
      tokens[j + 1]?.value === "." &&
      tokens[j + 2] &&
      tokens[j + 2].type !== "punct"
    ) {
      parts.push(tokens[j + 2].value);
      j += 2;
    }
    // BigQuery allows the whole path inside one pair of backticks.
    const path = parts.flatMap(p => p.split("."));
    if (path.length < 2) {
      return {
        error:
          `Write target "${path.join(".")}" must be schema-qualified ` +
          `(schema.table) so it can be checked against the write grants.`,
      };
    }
    targets.push({
      schema: path[path.length - 2],
      table: path[path.length - 1],
    });

    // MySQL multi-table forms (`DELETE a.t1, a.t2 …`, `UPDATE a JOIN b SET`)
    // write tables this scan would not attribute.
    if (word === "UPDATE" || word === "DELETE") {
      for (
        let k = j + 1;
        k < tokens.length && upper(tokens[k]) !== "SET";
        k++
      ) {
        if (word === "DELETE" && k > j + 1) break;
        if (tokens[k].value === "," || JOIN_WORDS.has(upper(tokens[k]))) {
          return {
            error: `Multi-table ${word} is not allowed in a governed write.`,
          };
        }
      }
    }
  }

  if (targets.length === 0) {
    return { error: "The statement writes no table." };
  }
  return { targets };
}
