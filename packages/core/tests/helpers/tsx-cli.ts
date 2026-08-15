import { createRequire } from 'node:module'

/**
 * Absolute path to the `tsx` CLI entry point, for tests that run the `oma` CLI
 * from TypeScript source in a child process.
 *
 * Resolved through Node's module resolution rather than a path with a fixed
 * number of `..` segments: `node_modules/.bin` does not always sit directly
 * above the workspace. A git worktree has no local `node_modules` and resolves
 * upwards to the main checkout, and a non-hoisted install places `node_modules`
 * inside the workspace. A wrong guess made `spawnSync` fail to launch at all,
 * surfacing as `status: null` instead of a CLI exit code.
 *
 * Spawn it with `process.execPath` rather than executing it directly, so the
 * call does not depend on the `node_modules/.bin` shim, which is a `.cmd`
 * wrapper on Windows that `spawnSync` cannot launch without a shell.
 */
export const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
