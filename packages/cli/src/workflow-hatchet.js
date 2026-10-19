// What a workflow file gets as `hatchet` (`import { hatchet } from
// "../hatchet"`) in a test run: the part of Hatchet's SDK the workspace's
// workflows use, recorded here and run by workflow-runner.js in one process.
// Anything else throws, rather than doing something the workers would not.

const unsupported = what => {
  throw new Error(
    `${what} is not supported in test runs; run it on the workers`,
  );
};

/** An object whose other properties throw when read. */
const only = (object, what) =>
  new Proxy(object, {
    get(target, key) {
      if (typeof key === "symbol" || key in target) return target[key];
      // `then` is how `await` asks whether a value is a promise: it is not.
      if (key === "then") return undefined;
      return unsupported(`${what}.${key}`);
    },
  });

const check = (options, allowed, what) => {
  for (const key of Object.keys(options ?? {})) {
    if (!allowed.includes(key)) unsupported(`${what}({ ${key} })`);
  }
};

export const WORKFLOW_OPTIONS = ["name", "description", "on"];
export const TASK_OPTIONS = [
  "name",
  "parents",
  "retries",
  "executionTimeout",
  "fn",
];

export const hatchet = only(
  {
    workflow(options) {
      check(options, WORKFLOW_OPTIONS, "hatchet.workflow");
      const workflow = {
        name: options.name,
        tasks: [],
        task(task) {
          check(task, TASK_OPTIONS, "task");
          const recorded = { ...task, parents: task.parents ?? [] };
          workflow.tasks.push(recorded);
          return recorded;
        },
      };
      return only(workflow, "workflow");
    },
  },
  "hatchet",
);

/** A step's `ctx`: its logger and its ancestors' outputs. */
export function makeContext(log, outputOf) {
  const logger = only(
    Object.fromEntries(
      ["debug", "info", "warn", "error"].map(level => [
        level,
        message => log(level, String(message)),
      ]),
    ),
    "ctx.logger",
  );
  return only({ logger, parentOutput: async task => outputOf(task) }, "ctx");
}
