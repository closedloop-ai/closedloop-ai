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

// Shared drift-finding shape for every collector guard in this directory. Each
// collects `{ file, message }` records for GitHub error annotations; defining
// the shape once keeps them structurally identical. Deliberately not an
// enumeration — the guard set grows (ISS-9221 added the artifact dimension) and
// a hand-listed roster here goes stale silently.
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

const ANNOTATION_PERCENT_PATTERN = /%/g;
const ANNOTATION_CARRIAGE_RETURN_PATTERN = /\r/g;
const ANNOTATION_LINE_FEED_PATTERN = /\n/g;

/**
 * Escape a workflow-command message payload (GitHub's `toCommandValue`).
 *
 * Load-bearing, not tidiness: every message these guards print is derived from
 * repository content — `collector/vendoring-state.json` is hand-written prose,
 * and `mergedUnapplied` reasons are free text — so an unescaped CR or LF would
 * terminate the `::error`/`::warning` command early and let the remainder parse
 * as a NEW workflow command, forging or suppressing annotations and masking the
 * output after it (davetho, #6917).
 *
 * A COPY of `escapeData` in `scripts/lint/github-annotations.ts`, which is
 * canonical: this package is published, so it cannot import repo `scripts/`.
 * `scripts/lint/github-annotations.test.ts` holds this copy to that original,
 * the same way `packages/vitest-config`'s copy is held (ISS-9661).
 */
export function escapeAnnotationData(value: string): string {
  return value
    .replace(ANNOTATION_PERCENT_PATTERN, "%25")
    .replace(ANNOTATION_CARRIAGE_RETURN_PATTERN, "%0D")
    .replace(ANNOTATION_LINE_FEED_PATTERN, "%0A");
}

/** One `::error` annotation, message escaped. */
export function errorAnnotation(file: string, message: string): string {
  return `::error file=${repoRootAnnotationPath(file)}::${escapeAnnotationData(message)}`;
}

/** One `::warning` annotation, message escaped. */
export function warningAnnotation(file: string, message: string): string {
  return `::warning file=${repoRootAnnotationPath(file)}::${escapeAnnotationData(message)}`;
}

/**
 * The hand-maintained vendoring ledger, and the one file in `collector/` that
 * no generator writes.
 *
 * Owned here rather than by either guard because both dimensions read it:
 * `check-collector-vendoring.ts` to load it, `collector-artifact-vendoring.ts`
 * to exclude it from the generated-artifact comparison and to address its own
 * annotations. Two copies would have to stay byte-identical for that exclusion
 * to keep matching after a rename, and nothing would pin them together.
 */
export const CollectorVendoringLedgerPath =
  "collector/vendoring-state.json" as const;

export function readCommittedArtifact(
  path: string,
  regenerateHint: string,
  stderr: ConsoleErrorLike
): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    stderr.error(
      errorAnnotation(
        path,
        `Unable to read committed collector artifact: ${describeError(error)}. ${regenerateHint}`
      )
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

// The collector drift guards all compare an expected set against a committed
// one with identical missing/extra set-diff logic, differing only in the two
// message strings. Hoist the diff here and let each guard pass its own message
// builders. Deliberately not an enumeration of callers — the guard set grows
// (ISS-9221 added two more call sites) and a hand-listed roster goes stale
// silently.
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

/**
 * The one part of a stated reason a machine can check, shared by every ledger
 * field that carries one.
 *
 * whitlockk settled the bar on `mergedUnapplied` in #6917: a reason is prose and
 * mostly has to be, but the ticket is the half a reader ACTS on, and an entry
 * saying `waiting` gives that reader nowhere to go. It is ONE constant rather
 * than one per field because two copies of a bar are two bars: the #6917
 * tightening landed on `mergedUnapplied` and would have had to be remembered
 * again for every later field, which is the drift a shared owner removes.
 */
export const REASON_TICKET_PATTERN = /\bISS-\d+\b/;

export type ReasonedSubjects = {
  /** Every subject the field names, reason coerced to "" when not a string. */
  all: Map<string, string>;
  /** Subjects whose reason is a non-blank string naming an `ISS-<number>`. */
  routed: Map<string, string>;
  /** Subjects with a missing or blank reason. */
  unreasoned: string[];
  /** Subjects whose reason is stated but routes nowhere. */
  unrouted: string[];
};

/**
 * Sort one reason-carrying ledger field's entries, without deciding anything.
 *
 * Deliberately returns a classification rather than findings: the two fields
 * that use it word their defects differently and disagree about what to do with
 * a bad entry — `mergedUnapplied` DROPS one so it cannot also print an
 * unroutable standing warning, while `keylessExcludedKeys` KEEPS it so the same
 * key is not also reported as undeclared. Folding either policy in here would
 * make the shared helper wrong for the other caller, so the caller keeps the
 * judgment and this keeps the loop and the bar.
 */
export function classifyReasonedSubjects(
  field: Record<string, unknown>
): ReasonedSubjects {
  const all = new Map<string, string>();
  const routed = new Map<string, string>();
  const unreasoned: string[] = [];
  const unrouted: string[] = [];

  for (const [subject, reason] of Object.entries(field)) {
    const stated = typeof reason === "string" ? reason : "";
    all.set(subject, stated);
    if (stated.trim().length === 0) {
      unreasoned.push(subject);
    } else if (REASON_TICKET_PATTERN.test(stated)) {
      routed.set(subject, stated);
    } else {
      unrouted.push(subject);
    }
  }

  return {
    all,
    routed,
    unreasoned: unreasoned.sort(),
    unrouted: unrouted.sort(),
  };
}
