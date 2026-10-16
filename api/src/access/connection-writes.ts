/**
 * Who may write through a connection (rfcs/data-source-access.md).
 *
 * Everyone may read. Writing is for the principals on the connection's
 * `writers` list, each anywhere or only to one schema or table. Work no
 * person or workflow started (syncs, flows, CDC, dbt) is not concerned.
 *
 * The read path pays nothing: a statement is classified in memory first, and
 * only a write looks further (the writers list comes with the connection;
 * the workspace's mode is cached). A workspace starts in "report": writes
 * that would be refused are recorded and run anyway, so the lists can be
 * filled from what people really do before anything is refused.
 */
import { Types } from "mongoose";
import {
  Workspace,
  WorkspaceMember,
  type IConnectionWriter,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import { getRequestContext } from "../logging/context";
import { loggers } from "../logging";
import {
  checkPreviewQuerySafety,
  stripLeadingSqlComments,
} from "../services/query-pagination.service";
import { countTopLevelSemicolons } from "../services/sql-query-utils";
import { ConnectionWriteEvent } from "./connection-write-event";

const logger = loggers.db();

export type WritesMode = "report" | "enforce";

// ---------------------------------------------------------------------------
// Is it a write? (in memory, every query)
// ---------------------------------------------------------------------------

/** Statements that only look: they never change anything. */
const LOOKING =
  /^(SHOW|DESCRIBE|DESC|EXPLAIN(?!\s+ANALY[SZ]E)|USE|VALUES|PRAGMA\s+(table_info|index_list|foreign_key_list))\b/i;

/** MongoDB shell methods that change data or structure. */
const MONGO_WRITE =
  /\.(insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|delete|deleteOne|deleteMany|remove|drop|dropDatabase|dropIndex|dropIndexes|createCollection|createIndex|createIndexes|renameCollection|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify)\s*\(|\$out\b|\$merge\b/;

const MONGO_READ_OPERATIONS = new Set([
  "find",
  "findOne",
  "aggregate",
  "count",
  "countDocuments",
  "distinct",
]);

/** Whether `query` would change something, judged without asking the database. */
export function isWrite(type: string, query: unknown): boolean {
  if (typeof query !== "string") {
    // A structured MongoDB request names its operation.
    const request = query as {
      operation?: string;
      pipeline?: unknown[];
    } | null;
    if (!request || typeof request !== "object") return false;
    if (request.operation && !MONGO_READ_OPERATIONS.has(request.operation)) {
      return true;
    }
    return MONGO_WRITE.test(JSON.stringify(request.pipeline ?? []));
  }
  if (type === "mongodb") return MONGO_WRITE.test(query);
  if (type === "cloudflare-kv") return /^\s*(put|set|delete)\b/i.test(query);
  const statement = stripLeadingSqlComments(query.trim());
  if (LOOKING.test(statement) && singleStatement(statement)) return false;
  return !checkPreviewQuerySafety(query).safe;
}

function singleStatement(sql: string): boolean {
  const { count, lastIndex } = countTopLevelSemicolons(sql);
  return count === 0 || (count === 1 && lastIndex === sql.trimEnd().length - 1);
}

// ---------------------------------------------------------------------------
// Where does it write? (only for writers limited to a schema or table)
// ---------------------------------------------------------------------------

/** One part of a name: quoted with backticks, double quotes, brackets, or bare. */
const PART = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|\[[^\]]+\]|[A-Za-z0-9_$-]+)`;
const TARGET = new RegExp(
  String.raw`^(?:INSERT\s+(?:OVERWRITE\s+)?(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?|TRUNCATE\s+(?:TABLE\s+)?|DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?)(${PART}(?:\s*\.\s*${PART}){0,2})`,
  "i",
);

export interface WriteTarget {
  schema?: string;
  table: string;
}

/**
 * The table one write statement changes, read from the statement itself: a
 * write names its target, unlike a read. Null when there is no single,
 * named target (several statements, a script, a procedure, a write inside a
 * CTE): a writer limited to one place is then refused, never guessed for.
 */
export function writeTarget(query: string): WriteTarget | null {
  const statement = stripLeadingSqlComments(query.trim());
  if (!singleStatement(statement)) return null;
  const name = statement.match(TARGET)?.[1];
  if (!name) return null;
  // `project.dataset.table` may be one backticked part: split it too.
  const parts = (name.match(new RegExp(PART, "g")) ?? [])
    .flatMap(part => unquote(part).split("."))
    .filter(Boolean);
  const table = parts.at(-1);
  if (!table) return null;
  return { table, schema: parts.at(-2) };
}

function unquote(part: string): string {
  const p = part.trim();
  if (/^[\x60"[]/.test(p)) return p.slice(1, -1);
  return p;
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function fits(where: string, target: WriteTarget): boolean {
  const [schema, table] = where.split(".");
  if (!sameName(schema, target.schema)) return false;
  return table ? sameName(table, target.table) : true;
}

// ---------------------------------------------------------------------------
// Who is writing, and may they?
// ---------------------------------------------------------------------------

/**
 * Who is acting: given explicitly (a scheduled console runs as its owner),
 * or the workflow or person of the request being served. Nobody for work
 * no request started: the system's, never checked.
 */
export function actingPrincipal(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const context = getRequestContext();
  if (context?.workflow) return `workflow:${context.workflow}`;
  if (context?.userId) return `user:${context.userId}`;
  return undefined;
}

export type WriteDecision =
  | { allowed: true; target?: WriteTarget }
  | {
      allowed: false;
      why: "not-a-writer" | "no-target" | "elsewhere";
      places: string[];
      target?: WriteTarget;
    };

/** Whether `principal` may run the write `query`, given the writers list. */
export function decideWrite(
  writers: IConnectionWriter[] | undefined,
  principal: string,
  query: unknown,
): WriteDecision {
  const mine = (writers ?? []).filter(w => w.principal === principal);
  if (mine.length === 0) {
    return { allowed: false, why: "not-a-writer", places: [] };
  }
  if (mine.some(w => !w.where)) return { allowed: true };
  const places = mine.map(w => w.where as string);
  const target = typeof query === "string" ? writeTarget(query) : null;
  if (!target) return { allowed: false, why: "no-target", places };
  if (places.some(where => fits(where, target))) {
    return { allowed: true, target };
  }
  return { allowed: false, why: "elsewhere", places, target };
}

export function refusal(
  decision: WriteDecision,
  connectionName: string,
): string {
  if (decision.allowed) return "";
  const places = decision.places.join(", ");
  switch (decision.why) {
    case "not-a-writer":
      return `Everyone can read ${connectionName}, but only the people and workflows an admin allowed can write to it. Ask an admin to add you in the connection's Access tab.`;
    case "no-target":
      return `You can write only to ${places} on ${connectionName}. Write one statement that names its table as schema.table.`;
    case "elsewhere":
      return `You can write only to ${places} on ${connectionName}, not to ${[decision.target?.schema, decision.target?.table].filter(Boolean).join(".")}.`;
  }
}

/**
 * Whether `principal` may write to `target` ("schema.table" or "table")
 * under `writers` as they are now; null target means "somewhere unknown".
 */
export function covers(
  writers: IConnectionWriter[] | undefined,
  principal: string,
  target: string | null,
): boolean {
  const mine = (writers ?? []).filter(w => w.principal === principal);
  if (mine.some(w => !w.where)) return true;
  if (!target) return false;
  const parts = target.split(".");
  const named: WriteTarget = {
    table: parts.at(-1) as string,
    schema: parts.at(-2),
  };
  return mine.some(w => fits(w.where as string, named));
}

/** The `user:` principals among `principals` who are not workspace members. */
export async function principalsOutsideWorkspace(
  workspaceId: string,
  principals: string[],
): Promise<string[]> {
  const people = principals.filter(p => p.startsWith("user:"));
  if (people.length === 0) return [];
  const members = await WorkspaceMember.find({
    workspaceId: new Types.ObjectId(workspaceId),
    userId: { $in: people.map(p => p.slice("user:".length)) },
  })
    .select("userId")
    .lean();
  const known = new Set(members.map(m => `user:${String(m.userId)}`));
  return people.filter(p => !known.has(p));
}

// ---------------------------------------------------------------------------
// The check executeQuery runs
// ---------------------------------------------------------------------------

const MODE_TTL_MS = 30_000;
const modes = new Map<string, { mode: WritesMode; at: number }>();

/** The workspace's mode, cached briefly: it is read only on writes. */
export async function writesMode(workspaceId: string): Promise<WritesMode> {
  const cached = modes.get(workspaceId);
  if (cached && Date.now() - cached.at < MODE_TTL_MS) return cached.mode;
  const workspace = await Workspace.findById(workspaceId)
    .select("settings.connectionWrites")
    .lean();
  const mode: WritesMode =
    workspace?.settings?.connectionWrites === "enforce" ? "enforce" : "report";
  modes.set(workspaceId, { mode, at: Date.now() });
  return mode;
}

/** Forget a cached mode (after it changes). */
export function forgetWritesMode(workspaceId: string): void {
  modes.delete(workspaceId);
}

/**
 * Null when the query may run; otherwise why it may not. A read returns at
 * once. A write is recorded either way (who, which connection, where, and
 * whether it was allowed), and refused only when the workspace enforces.
 */
export async function checkConnectionWrite(
  database: Pick<
    IDatabaseConnection,
    "_id" | "workspaceId" | "name" | "type" | "writers"
  >,
  query: unknown,
  options: { readOnly?: boolean; actor?: string } = {},
): Promise<string | null> {
  if (options.readOnly) return null;
  if (!database._id || !database.workspaceId) return null; // a connection being tested
  const principal = actingPrincipal(options.actor);
  if (!principal) return null;
  if (!isWrite(database.type, query)) return null;

  const decision = decideWrite(database.writers, principal, query);
  const mode = await writesMode(String(database.workspaceId));
  // Where it wrote, for whoever reviews the log: worked out for writes only.
  const target =
    decision.target ?? (typeof query === "string" ? writeTarget(query) : null);
  void ConnectionWriteEvent.create({
    workspaceId: new Types.ObjectId(String(database.workspaceId)),
    connectionId: new Types.ObjectId(String(database._id)),
    principal,
    target: target
      ? [target.schema, target.table].filter(Boolean).join(".")
      : undefined,
    allowed: decision.allowed,
    mode,
  }).catch(error =>
    logger.warn("Could not record a connection write", { error }),
  );
  if (decision.allowed || mode !== "enforce") return null;
  return refusal(decision, database.name);
}
