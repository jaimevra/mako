// What a worker needs before it can load `workflows/`: the shared files the
// image supplies, the runtime's packages, and a typecheck. Used by
// entrypoint.mjs (a commit, in the workspace's worker) and run.mjs (a
// checkout, in a person's sandbox) the same way.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Make `root` (a folder holding `workflows/`) loadable: the Hatchet client
 * and the Mako helpers every workflow imports (a repo with its own copy
 * keeps it), the runtime's packages, and ES-module loading for `.ts` files.
 */
export function prepare(root) {
  for (const file of ["hatchet.ts", "lib/mako.ts"]) {
    const target = join(root, "workflows", file);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(RUNTIME_DIR, "defaults", file), target);
  }
  // Workflow code resolves packages from the runtime, nowhere else.
  const modules = join(root, "node_modules");
  if (!existsSync(modules))
    symlinkSync(join(RUNTIME_DIR, "node_modules"), modules);
  // Workflow files are ES modules; without this Node loads them as CommonJS.
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
}

/** Typecheck `workflows/` under a prepared `root`. Returns the errors, or null. */
export function typecheck(root) {
  const tsconfig = join(root, "tsconfig.workflows.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      include: ["workflows/**/*.ts"],
    }),
  );
  try {
    execFileSync(join(RUNTIME_DIR, "node_modules/.bin/tsc"), ["-p", tsconfig], {
      cwd: root,
      stdio: "pipe",
    });
    return null;
  } catch (err) {
    return err.stdout?.toString() || err.message;
  }
}
