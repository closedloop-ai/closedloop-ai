import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { isRiskyAllowedDirectory } from "../../src/shared/sandbox-policy.js";

/**
 * Parent of every {@link createTempDirManager} sandbox-root fixture: a
 * directory whose canonical realpath the desktop sandbox policy ACCEPTS, and
 * which belongs to no user's home.
 *
 * Both halves are load-bearing, and each obvious choice fails one of them.
 * `os.tmpdir()` on macOS realpaths under `/private/var/folders/...` and `/tmp`
 * realpaths to `/private/tmp`, both of which `isRiskyAllowedDirectory` rejects
 * on the `/private` prefix — so a fixture there can never be persisted as a
 * sandbox base, and the suite passes on Linux CI while failing on the macOS
 * candidate cut. `os.homedir()` clears that check but breaks the other half:
 * the `test:node` lane has a 900s whole-runner cap that SIGTERMs the run, and
 * anything {@link createTempDirManager}'s `afterEach` never reached is then
 * stranded in the operator's real home directory — the reason
 * `security-sandbox.test.ts`'s ISS-6128 helper prefers `/tmp` in the first
 * place (ISS-10655).
 *
 * `/Users/Shared` satisfies both on macOS: it realpaths to itself, belongs to
 * no user, and a child of it is two segments deep so it clears the
 * `/Users/<name>` risky-root check. On Linux `/tmp` already realpaths to
 * itself. Pinned by `temp-dir-sandbox-root.test.ts`.
 */
const SANDBOX_ROOT_TEMP_PARENT =
  process.platform === "darwin" ? "/Users/Shared" : "/tmp";

export function createTempDirManager(prefix: string): {
  cleanupTempDirs: () => Promise<void>;
  makeSandboxRootTempDir: (prefixOverride?: string) => string;
  makeTempDir: (prefixOverride?: string) => string;
} {
  const tempPathsToClean: string[] = [];

  afterEach(cleanupTempDirs);

  async function cleanupTempDirs(): Promise<void> {
    for (const p of tempPathsToClean.splice(0)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }

  function makeTempDir(prefixOverride?: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefixOverride ?? prefix));
    tempPathsToClean.push(dir);
    return dir;
  }

  /**
   * A temp dir whose canonical realpath is a sandbox root the desktop policy
   * ACCEPTS — see {@link SANDBOX_ROOT_TEMP_PARENT} for why that rules out both
   * `os.tmpdir()` and the home directory. Reach for it only where the code
   * under test actually runs `validateSandboxBaseDirectory`; every other
   * fixture wants {@link makeTempDir}.
   *
   * The guard makes that first sentence enforced rather than assumed
   * (marisolashgrove review): if the parent ever stops clearing the policy, the
   * suite says so here, naming the fixture, instead of surfacing as
   * SANDBOX_RISKY_ROOT_MESSAGE out of a handler and reading as a policy bug.
   */
  function makeSandboxRootTempDir(prefixOverride?: string): string {
    const dir = realpathSync.native(
      mkdtempSync(
        path.join(
          SANDBOX_ROOT_TEMP_PARENT,
          `cl-test-${prefixOverride ?? prefix}`
        )
      )
    );
    tempPathsToClean.push(dir);
    if (isRiskyAllowedDirectory(dir)) {
      throw new Error(
        `makeSandboxRootTempDir minted ${dir}, which the sandbox policy REFUSES as a base directory. Its parent (${SANDBOX_ROOT_TEMP_PARENT}) no longer clears isRiskyAllowedDirectory — the fixture is wrong, not the policy.`
      );
    }
    return dir;
  }

  return { cleanupTempDirs, makeSandboxRootTempDir, makeTempDir };
}
