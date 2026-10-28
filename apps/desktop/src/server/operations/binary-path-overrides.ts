/**
 * @file binary-path-overrides.ts
 * @description The user-configured binary-path overrides and the resolvers built
 * on them, extracted from the former loop runner by ISS-8906.
 *
 * The DB store's module graph needs these resolvers: session attribution
 * reaches `attribution-path-memo` → `getOverrideBinaryPaths`, and
 * `git-helpers` reaches `getResolvedGitPath`. When they lived in a large module
 * that also pulled `electron-store` → `require('electron')`, that graph landed on
 * the `node:worker_threads` store thread, where there is no `electron`
 * built-in. The store therefore never opened and the install captured nothing.
 *
 * So: keep this module free of `electron`, `electron-log` and `electron-store`.
 * Its only dependencies are `node:async_hooks` and `shell-path.ts`, which the
 * store thread already loads.
 * `apps/desktop/test/worker-entry-electron-free-graph.test.ts` is the guard.
 *
 * NOT the same concern as the sibling `binary-paths.ts`, which owns the gateway
 * ROUTES that read and patch the override map, and the canonical `BinaryPaths`
 * shape those routes speak. This module owns RESOLUTION — turning an override
 * plus the login-shell PATH into an absolute binary path — and imports that
 * shape rather than re-declaring it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  resetShellPathCache,
  resolveBinaryFromLoginShell,
  resolveBinaryFromLoginShellSync,
} from "../shell-path.js";
import type { BinaryPaths } from "./binary-paths.js";

/**
 * User-configured binary path overrides returned by Desktop settings.
 *
 * The canonical shape is `binary-paths.ts`'s `BinaryPaths` — the same object the
 * gateway routes there read and patch — so it is imported rather than
 * re-declared. A hand-copied twin let a key added to the routes' shape reach no
 * resolver: structural typing accepts the wider object, and nothing fails
 * `tsc`. A `type` import adds no runtime edge, so this module stays loadable on
 * the worker thread.
 */
export type BinaryPathsResolver = () => BinaryPaths;

/**
 * Module-level binary paths resolver, configured once in GatewayRouter constructor.
 * {@link runWithBinaryPathsResolver} binds a scoped one through async-local
 * storage, which takes precedence, so concurrent gateway instances in tests
 * cannot race each other's overrides.
 */
let overrideGetBinaryPaths: BinaryPathsResolver | null = null;
const binaryPathsResolverContext = new AsyncLocalStorage<BinaryPathsResolver>();

export function getActiveBinaryPathsResolver(): BinaryPathsResolver | null {
  return binaryPathsResolverContext.getStore() ?? overrideGetBinaryPaths;
}

export function configureBinaryPathsResolver(
  resolver: BinaryPathsResolver | null
): void {
  overrideGetBinaryPaths = resolver;
}

export function getOverrideBinaryPaths(): BinaryPaths | null {
  return getActiveBinaryPathsResolver()?.() ?? null;
}

export function getResolvedGitPath(): string {
  const override = getOverrideBinaryPaths()?.git;
  const resolved = resolveBinaryFromLoginShellSync("git", override);
  if (resolved.source !== "override_invalid") {
    return resolved.path;
  }
  refuseUnusableOverrideInTests("git", resolved.path);
  return resolveBinaryFromLoginShellSync("git").path;
}

/**
 * Async twin of `getResolvedGitPath`, for main-thread callers.
 *
 * ISS-6132: the sync resolver bottoms out in `getShellPathSync`, which on a
 * cold cache runs `execFileSync($SHELL, "-ilc", …)` for up to
 * `SHELL_PATH_TIMEOUT_MS` per arg variant. Converting the git calls to
 * `execFile` while still resolving the binary synchronously would leave a
 * multi-second main-thread freeze on the FIRST command — precisely the reported
 * repro. Placed beside its sync counterpart, mirroring `shell-path.ts`'s own
 * sync/async pairing.
 */
export async function getResolvedGitPathAsync(): Promise<string> {
  const override = getOverrideBinaryPaths()?.git;
  const resolved = await resolveBinaryFromLoginShell("git", override);
  if (resolved.source !== "override_invalid") {
    return resolved.path;
  }
  refuseUnusableOverrideInTests("git", resolved.path);
  return (await resolveBinaryFromLoginShell("git")).path;
}

/**
 * Reset the shared login-shell PATH cache used by sync binary wrappers.
 * Intended for tests where PATH changes between cases.
 */
export function resetResolvedClaudePath(): void {
  resetShellPathCache();
}

export function getResolvedClaudePath(): string {
  return resolveBinaryFromLoginShellSync(
    "claude",
    getOverrideBinaryPaths()?.claude
  ).path;
}

/**
 * Async twin of `getResolvedClaudePath`, for main-thread callers (ISS-11596):
 * the sync resolver can run the login shell with `execFileSync` on a cold PATH
 * cache. Same answer in every branch, including an unusable override, which
 * both return as-is.
 */
export async function getResolvedClaudePathAsync(): Promise<string> {
  return (
    await resolveBinaryFromLoginShell(
      "claude",
      getOverrideBinaryPaths()?.claude
    )
  ).path;
}

/**
 * Run `fn` with `resolver` bound for its whole async continuation, so concurrent
 * gateway instances cannot race each other's overrides. The `AsyncLocalStorage`
 * itself stays module-private: {@link configureBinaryPathsResolver} is the
 * process-wide seam and this is the scoped one, and a caller holding the raw
 * store could set a resolver by neither.
 */
export function runWithBinaryPathsResolver<T>(
  resolver: BinaryPathsResolver,
  fn: () => T
): T {
  return binaryPathsResolverContext.run(resolver, fn);
}

/**
 * Name of the env var that turns the fall-through above into a hard failure.
 * The desktop test runners set it (`scripts/hermetic-git-env.mjs` →
 * `DESKTOP_TEST_STRICT_ENV`); a packaged build never does.
 *
 * ISS-10194. The fallback is deliberate IN PRODUCTION — a user whose configured
 * git path went stale should still get a working git rather than a dead app —
 * so the strictness is gated rather than the fallback removed. In a test the
 * same line means the opposite: the suite believes its fake binary is installed
 * while the REAL one runs.
 */
export const STRICT_BINARY_OVERRIDES_ENV_VAR =
  "CLOSEDLOOP_DESKTOP_STRICT_BINARY_OVERRIDES";

function refuseUnusableOverrideInTests(
  logicalName: string,
  override: string
): void {
  if (process.env[STRICT_BINARY_OVERRIDES_ENV_VAR] !== "1") {
    return;
  }
  throw new Error(
    `Binary override for "${logicalName}" is configured but not executable: ${override}. ` +
      `Refusing to fall back to the host ${logicalName} because ${STRICT_BINARY_OVERRIDES_ENV_VAR}=1. ` +
      "Fix the override path (ISS-10194): a test whose fake binary did not install must fail here, not run the real one."
  );
}
