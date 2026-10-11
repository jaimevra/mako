/**
 * Who may change workflows. A workflow on main runs on the workspace's
 * schedule with the workspace's data, so writing, merging or giving one a
 * webhook is an admin's call; members start runs. The rule is read at every
 * door into `workflows/`: the git endpoint, a merge to main, the agent's
 * file tools and the webhook switch.
 */
export const mayChangeWorkflows = (role?: string | null): boolean =>
  role === "owner" || role === "admin";

export const WORKFLOWS_ADMIN_ONLY =
  "Only workspace admins change workflows; members run them.";
