import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TelemetryContractPath } from "./telemetry-contract-constants";

/**
 * Shared helpers for the keyless-telemetry Collector codegen scripts
 * (`generate-collector-allowlist.ts` — FEA-2170 — and
 * `generate-collector-posthog-routing.ts` — FEA-1991). Both render otelcol YAML
 * fragments from the `@closedloop-ai/telemetry-contract` attribute SSOT, so the
 * YAML-safety guarantee and the artifact writer live here once.
 */

// Telemetry attribute names are dotted lowercase OTel-style identifiers. The
// generated fragments embed them as bare (unquoted) YAML scalars / inside OTTL
// string keys, which is only safe for this character set; a YAML- or
// OTTL-significant character (e.g. a leading `*`/`&`/`!`, an embedded `: `, or a
// quote) would render an invalid or mis-parsed fragment. Assert the constraint
// at generation so a future contract key that violates it fails loudly here
// instead of silently corrupting the vendored collector config.
export const YAML_SAFE_ATTRIBUTE_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export function assertYamlSafeKeys(
  keys: readonly string[],
  context: string
): void {
  const unsafe = keys.filter((key) => !YAML_SAFE_ATTRIBUTE_KEY.test(key));
  if (unsafe.length > 0) {
    throw new Error(
      `Telemetry attribute key(s) are not safe to emit as bare scalars in ${context}: ${unsafe.join(", ")}. Quote them in the fragment renderer before adding such keys to the contract.`
    );
  }
}

export function writeGeneratedArtifact(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

// Shared parsing predicates for the collector drift guards
// (`check-collector-allowlist.ts` and `check-collector-posthog-routing.ts`),
// which both validate committed JSON/YAML artifacts against the contract.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Shared drift-finding shape for the collector guards
// (`check-collector-allowlist.ts`, `check-collector-tail-sampling.ts`, and
// `check-collector-posthog-routing.ts`). Each guard collects `{ file, message }`
// records for GitHub error annotations; defining the shape once keeps the three
// guards structurally identical.
export type CollectorGuardFinding = {
  file: string;
  message: string;
};

export type ConsoleErrorLike = Pick<typeof console, "error">;

// GitHub Actions resolves `::error file=` paths from the repository root, while
// the guards read/evaluate artifacts with package-relative paths (they run with
// cwd at the package root under `pnpm --filter`). Prefix the package root so the
// annotation links to the file in the PR diff. Owning the `::error file=` format
// in one place keeps the two guards' annotations identical.
export function repoRootAnnotationPath(packageRelativePath: string): string {
  return `${TelemetryContractPath.PackageRoot}/${packageRelativePath}`;
}

export function readCommittedArtifact(
  path: string,
  regenerateHint: string,
  stderr: ConsoleErrorLike
): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    stderr.error(
      `::error file=${repoRootAnnotationPath(path)}::Unable to read committed collector artifact: ${describeError(error)}. ${regenerateHint}`
    );
    // An unreadable/missing artifact is itself drift: returning an empty source
    // forces the evaluation to fail (it cannot match a fresh render).
    return "";
  }
}

// Builds the human-readable message for one branch of a set diff from the
// affected (already-sorted) keys. Each guard supplies its own wording so the
// finding reads in that artifact's terms.
export type DiffMessageBuilder = (keys: string[]) => string;

// Both collector drift guards (`check-collector-allowlist.ts` and
// `check-collector-posthog-routing.ts`) compare an expected contract key set
// against the committed artifact's key set with identical missing/extra set-diff
// logic, differing only in the two message strings. Hoist the diff here and let
// each guard pass its own message builders.
export function diffFindings(
  file: string,
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
  messages: {
    missingMessage: DiffMessageBuilder;
    extraMessage: DiffMessageBuilder;
  }
): CollectorGuardFinding[] {
  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const extra = [...actual].filter((key) => !expected.has(key)).sort();
  const findings: CollectorGuardFinding[] = [];

  if (missing.length > 0) {
    findings.push({ file, message: messages.missingMessage(missing) });
  }
  if (extra.length > 0) {
    findings.push({ file, message: messages.extraMessage(extra) });
  }

  return findings;
}
