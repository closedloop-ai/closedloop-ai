import { RdsCaBundleStatus } from "./rds-ca-status.js";

/**
 * Argument parsing and exit-code mapping for `generate-rds-ca-bundle.ts`.
 *
 * Extracted from that script so the operator-facing CLI contract can be
 * unit-tested without invoking `main` — the same reason `connection-target.ts`
 * and `target-resolution.ts` were extracted from `scripts/seed.ts`. The script
 * remains the entry point and still owns fetching, validation, and file writes.
 *
 * Each helper takes `argv` explicitly rather than reading `process.argv`, so a
 * test does not have to mutate and restore a process global to exercise it.
 */

/**
 * Maps a drift-check result to a process exit code.
 *
 * The three-way split is load-bearing for CI: `2` means the bundle genuinely
 * drifted and must be regenerated, while `1` means the check itself could not
 * reach a verdict (fetch failure, invalid bundle, unexpected error). A caller
 * that collapses both to "non-zero" cannot tell "AWS rotated the CA" from
 * "the network was down".
 */
export function statusExitCode(status: RdsCaBundleStatus): number {
  if (status === RdsCaBundleStatus.Match) {
    return 0;
  }
  if (status === RdsCaBundleStatus.Drift) {
    return 2;
  }
  return 1;
}

/**
 * Returns the path given to `--status-json`, or `undefined` when the flag is
 * absent. Throws when the flag is present without a path — an unwritten status
 * file must not be mistaken for a passing check.
 */
export function readStatusJsonPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--status-json");
  if (index === -1) {
    return undefined;
  }
  const path = argv[index + 1];
  if (!path) {
    throw new Error("--status-json requires an output path");
  }
  return path;
}

export function shouldCheck(argv: string[]): boolean {
  return argv.includes("--check");
}

export function shouldRunMain(argv: string[]): boolean {
  return argv[1]?.endsWith("generate-rds-ca-bundle.ts") ?? false;
}
