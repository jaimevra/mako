/**
 * What starts a workflow without a person. A workflow is deployed with its
 * triggers off and runs only when started by hand; an admin activates it,
 * and its schedule and webhook go live. A webhook is turned on per workflow:
 * that makes a URL with its own secret, and a POST to it starts a run with
 * the request's JSON as input; with `?sandbox=<user>` it starts that
 * person's sandbox version instead (the test URL, active or not). Turning
 * it off forgets the secret, so turning it on again makes a new URL.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { decryptString, encryptString } from "../services/crypto.service";
import { HatchetError } from "./hatchet";

type Webhooks = Record<string, string> | undefined;

/** The name becomes a key, a URL segment and a Hatchet workflow name. */
function checkName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new HatchetError(`Invalid workflow: ${name}`, 400);
  }
}

function urlOf(workspaceId: string, name: string, secret: string): string {
  const base = (
    process.env.API_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:8080"
  ).replace(/\/+$/, "");
  return `${base}/api/workflows/hooks/${workspaceId}/${name}/${secret}`;
}

/** Turn a workflow's triggers on or off. The worker re-registers it. */
export async function setActive(
  workspaceId: string,
  name: string,
  active: boolean,
): Promise<void> {
  checkName(name);
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    active
      ? { $addToSet: { "workflows.active": name } }
      : { $pull: { "workflows.active": name } },
  );
}

/** Turn a workflow's webhook on or off. Returns its URL, or null when off. */
export async function setWebhook(
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<string | null> {
  checkName(name);
  const path = `workflows.webhooks.${name}`;
  const secret = randomBytes(24).toString("hex");
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    enabled
      ? { $set: { [path]: encryptString(secret) } }
      : { $unset: { [path]: "" } },
  );
  return enabled ? urlOf(workspaceId, name, secret) : null;
}

/** The workspace's webhook URLs, by workflow. */
export function webhookUrls(
  workspaceId: string,
  webhooks: Webhooks,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(webhooks ?? {}).map(([name, stored]) => [
      name,
      urlOf(workspaceId, name, decryptString(stored)),
    ]),
  );
}

/** Whether `given` is the secret of the webhook turned on for `name`. */
export function isWebhookSecret(
  webhooks: Webhooks,
  name: string,
  given: string,
): boolean {
  // Own keys only: `constructor` is not a workflow.
  if (!webhooks || !Object.hasOwn(webhooks, name)) return false;
  const expected = Buffer.from(decryptString(webhooks[name]));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
