import type { WriteGrant } from "../store/schemaStore";

/**
 * What a database-tree node is, as a write-grant target: a schema-like
 * container (`table: "*"`) or one table in it. Mirrors the API's
 * services/write-grants.ts, where a target is schema.table.
 */
export interface GrantTarget {
  schema: string;
  table: string;
}

const POSTGRES_FAMILY = new Set([
  "postgresql",
  "cloudsql-postgres",
  "redshift",
]);
// In MySQL and ClickHouse a "database" is what the SQL calls the schema.
const DATABASE_IS_SCHEMA = new Set(["mysql", "clickhouse"]);

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The grant target a tree node stands for, or null if it cannot be granted. */
export function grantTargetForNode(
  dbType: string,
  kind: string,
  metadata: Record<string, unknown> | undefined,
): GrantTarget | null {
  const m = metadata ?? {};
  if (dbType === "bigquery") {
    const dataset = str(m.datasetId);
    if (!dataset) return null;
    if (kind === "dataset") return { schema: dataset, table: "*" };
    // Date-sharded groups (events_YYYYMMDD → "events_") are not one table.
    const table = str(m.tableGroup);
    if (kind === "table" && table && !table.endsWith("_")) {
      return { schema: dataset, table };
    }
    return null;
  }
  if (POSTGRES_FAMILY.has(dbType)) {
    const schema = str(m.schema);
    if (!schema) return null;
    if (kind === "schema") return { schema, table: "*" };
    const table = str(m.table);
    return kind === "table" && table ? { schema, table } : null;
  }
  if (DATABASE_IS_SCHEMA.has(dbType)) {
    const schema = str(m.databaseName);
    if (!schema) return null;
    if (kind === "database") return { schema, table: "*" };
    const table = str(m.tableName);
    return kind === "table" && table ? { schema, table } : null;
  }
  return null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Grants on exactly this target (what the dialog edits). */
export function grantsOn(
  grants: WriteGrant[] | undefined,
  target: GrantTarget,
): WriteGrant[] {
  return (grants ?? []).filter(
    g => same(g.schema, target.schema) && same(g.table, target.table),
  );
}

/** Schema-wide grants a table inherits (shown read-only in the dialog). */
export function inheritedGrants(
  grants: WriteGrant[] | undefined,
  target: GrantTarget,
): WriteGrant[] {
  if (target.table === "*") return [];
  return (grants ?? []).filter(
    g => same(g.schema, target.schema) && g.table === "*",
  );
}

/** Whether any grant lets someone write here (drives the tree badge). */
export function isWritable(
  grants: WriteGrant[] | undefined,
  target: GrantTarget,
): boolean {
  return (grants ?? []).some(
    g =>
      same(g.schema, target.schema) &&
      (g.table === "*" || target.table === "*" || same(g.table, target.table)),
  );
}

export const ROLE_PRINCIPALS = [
  {
    principal: "role:member",
    label: "Members",
    detail: "workspace role, and above",
  },
  {
    principal: "role:admin",
    label: "Admins",
    detail: "workspace role, and owners",
  },
  { principal: "role:owner", label: "Owners", detail: "workspace role" },
  {
    principal: "workflows",
    label: "Workflows",
    detail: "scheduled workflow runs",
  },
] as const;
