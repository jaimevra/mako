/**
 * Who may use a database connection (rfcs/data-source-access.md).
 *
 * A connection is either open to everyone in the workspace (the default, and
 * every connection that existed before this) or restricted: then only the
 * workspace owner and the principals on its list may use it, each at a level:
 *
 *   read    queries run read-only
 *   write   any statement the credential allows (creating tables included)
 *   manage  write, plus changing the list, the credentials, or deleting it
 *
 * Admins get nothing special on a restricted connection: the workspace has
 * many, and they can make more.
 *
 * `loadConnection` / `authorizeConnection` are how a person obtains a
 * connection. They mark the document; inside a person's request,
 * `executeQuery` refuses a restricted connection without that mark, so a path
 * that skipped the gate fails instead of reading. Work outside any request
 * (sync, CDC, scheduled runs) is the system's; jobs that run for no person
 * inside a request mark theirs with `asSystemConnection`.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  type ConnectionAccessLevel,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import { getRequestContext } from "../logging/context";
import { workspaceService } from "../services/workspace.service";

const RANK: Record<ConnectionAccessLevel, number> = {
  read: 1,
  write: 2,
  manage: 3,
};

/** How this in-memory connection was obtained. Survives object spread. */
const GRANT = Symbol.for("mako.connectionGrant");
type Grant = ConnectionAccessLevel | "system";

type WithAccess = Pick<IDatabaseConnection, "access">;

export class ConnectionAccessError extends Error {
  readonly status = 403;
  constructor(
    message = "This connection is restricted. Ask one of its managers for access.",
  ) {
    super(message);
    this.name = "ConnectionAccessError";
  }
}

export function userPrincipal(userId: string): string {
  return `user:${userId}`;
}

export function isRestricted(connection: WithAccess): boolean {
  return connection.access?.restricted === true;
}

/**
 * What `userId` may do with `connection`, or null when they may not use it.
 * An unrestricted connection is unchanged from before: everyone in the
 * workspace, with whatever their role and key already allow.
 */
export function connectionLevel(
  connection: WithAccess,
  userId: string | undefined,
  memberRole: string | undefined,
): ConnectionAccessLevel | null {
  if (!isRestricted(connection)) return "write";
  if (memberRole === "owner") return "manage";
  if (!userId) return null;
  const entry = connection.access?.entries?.find(
    e => e.principal === userPrincipal(userId),
  );
  return entry?.level ?? null;
}

/**
 * Who may change who uses a connection. Restricted: its managers and the
 * workspace owner. Not yet restricted: the owner and admins, the same people
 * who may delete a connection today; restricting only takes access away.
 */
export function canManageConnectionAccess(
  connection: WithAccess,
  userId: string | undefined,
  memberRole: string | undefined,
): boolean {
  if (!isRestricted(connection)) {
    return memberRole === "owner" || memberRole === "admin";
  }
  return connectionLevel(connection, userId, memberRole) === "manage";
}

function mark<T extends object>(connection: T, grant: Grant): T {
  Object.defineProperty(connection, GRANT, {
    value: grant,
    enumerable: true,
    configurable: true,
  });
  return connection;
}

/** For system jobs that act for no person: sync, flows at run time, migrations. */
export function asSystemConnection<T extends object | null | undefined>(
  connection: T,
): T {
  return connection ? mark(connection, "system") : connection;
}

/**
 * The second check, where a query runs. A restricted connection must have
 * come through `loadConnection` (or be a system job's); a `read` grant forces
 * the query read-only. Returns the read-only flag to use.
 */
export function assertMayQuery(
  connection: object,
  readOnly: boolean | undefined,
): boolean | undefined {
  if (!isRestricted(connection as WithAccess)) return readOnly;
  const grant = (connection as { [GRANT]?: Grant })[GRANT];
  if (grant) return grant === "read" ? true : readOnly;
  // Work no person started (sync, CDC, flow and dashboard runs, all outside
  // any request) is the system's. Inside a person's request, a restricted
  // connection must have come through the gate.
  if (!getRequestContext()?.userId) return readOnly;
  throw new ConnectionAccessError(
    "This connection is restricted, and this query did not come through its access check.",
  );
}

/**
 * The one way to obtain a connection for a person. Throws
 * `ConnectionAccessError` when they may not use it at `need`, and returns
 * null when it does not exist in this workspace.
 */
export async function loadConnection(input: {
  workspaceId: string | Types.ObjectId;
  connectionId: string | Types.ObjectId;
  userId: string | undefined;
  /** Their workspace role, when the caller already has it. */
  memberRole?: string;
  need?: ConnectionAccessLevel;
}): Promise<IDatabaseConnection | null> {
  const { workspaceId, connectionId, userId } = input;
  if (!Types.ObjectId.isValid(String(connectionId))) return null;
  const connection = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(String(connectionId)),
    workspaceId: new Types.ObjectId(String(workspaceId)),
  });
  if (!connection) return null;
  const level = await levelFor(
    connection,
    workspaceId,
    actingUser(userId),
    input.memberRole,
  );
  const need = input.need ?? "read";
  if (!level || RANK[level] < RANK[need]) {
    throw new ConnectionAccessError(
      level
        ? `Your access to this connection is ${level}; this needs ${need}.`
        : undefined,
    );
  }
  return mark(connection, level);
}

/** Mark an already-loaded connection after checking `userId` may use it. */
export async function authorizeConnection<T extends WithAccess>(
  connection: T,
  input: {
    workspaceId: string | Types.ObjectId;
    userId: string | undefined;
    memberRole?: string;
    need?: ConnectionAccessLevel;
  },
): Promise<T> {
  const level = await levelFor(
    connection,
    input.workspaceId,
    actingUser(input.userId),
    input.memberRole,
  );
  const need = input.need ?? "read";
  if (!level || RANK[level] < RANK[need]) {
    throw new ConnectionAccessError(
      level
        ? `Your access to this connection is ${level}; this needs ${need}.`
        : undefined,
    );
  }
  return mark(connection as T & object, level);
}

/**
 * `authorizeConnection` for routes: why `userId` may not use the connection
 * at `need`, or null when they may (and it is now marked for its queries).
 */
export async function accessDenial(
  connection: WithAccess,
  input: {
    workspaceId: string | Types.ObjectId;
    userId: string | undefined;
    memberRole?: string;
    need?: ConnectionAccessLevel;
  },
): Promise<string | null> {
  try {
    await authorizeConnection(connection, input);
    return null;
  } catch (error) {
    if (error instanceof ConnectionAccessError) return error.message;
    throw error;
  }
}

/** The connections in a list that `userId` may use; unrestricted ones always. */
export async function usableConnections<T extends WithAccess>(
  connections: T[],
  input: {
    workspaceId: string | Types.ObjectId;
    userId: string | undefined;
    memberRole?: string;
  },
): Promise<T[]> {
  if (!connections.some(isRestricted)) return connections;
  const userId = actingUser(input.userId);
  const role = input.memberRole ?? (await roleOf(input.workspaceId, userId));
  return connections.filter(c => connectionLevel(c, userId, role) !== null);
}

/**
 * The person acting: given explicitly, or the signed-in user of the request
 * being served (session, API key or MCP token; auth records it). Nobody, for
 * work no request started: a restricted connection is then refused unless
 * the job marked it as system.
 */
function actingUser(userId: string | undefined): string | undefined {
  return userId ?? getRequestContext()?.userId;
}

async function levelFor(
  connection: WithAccess,
  workspaceId: string | Types.ObjectId,
  userId: string | undefined,
  memberRole: string | undefined,
): Promise<ConnectionAccessLevel | null> {
  // An unrestricted connection needs no lookup: nothing changes for it.
  if (!isRestricted(connection)) return "write";
  const role = memberRole ?? (await roleOf(workspaceId, userId));
  return connectionLevel(connection, userId, role);
}

async function roleOf(
  workspaceId: string | Types.ObjectId,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  const member = await workspaceService
    .getMember(String(workspaceId), userId)
    .catch(() => null);
  return member?.role;
}
