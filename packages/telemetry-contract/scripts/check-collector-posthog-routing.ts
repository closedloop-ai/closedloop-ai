import YAML from "yaml";
import {
  CollectorProductSignalAttributeKeys,
  TelemetryAttribute,
} from "../src/attributes";
import {
  type CollectorGuardFinding,
  type ConsoleErrorLike,
  describeError,
  diffFindings,
  isRecord,
  isStringArray,
  readCommittedArtifact,
  repoRootAnnotationPath,
} from "./collector-codegen-common";
import {
  CollectorPosthogIdentityPath,
  CollectorPosthogRoutingPath,
  collectorPosthogRoutingArtifacts,
  POSTHOG_FILTER_PROCESSOR_NAME,
  POSTHOG_IDENTITY_PROCESSOR_NAME,
  PosthogIdentityAttribute,
} from "./generate-collector-posthog-routing";

/**
 * Drift guard (FEA-1991): fail the build when the committed PostHog-routing
 * artifacts no longer match the contract's product-signal marker SSOT
 * ({@link CollectorProductSignalAttributeKeys}). This turns a silently
 * mis-routed PostHog leg — sending nothing, or leaking non-product spans — into
 * a red build.
 *
 * `evaluateCollectorPosthogRouting` is pure so it is unit-testable without disk;
 * the CLI wrapper reads the committed artifacts and emits GitHub error
 * annotations resolved from the repository root.
 */

type EvaluateInput = {
  expectedKeys: readonly string[];
  identityFragmentSource?: string;
  identityManifestSource?: string;
  manifestSource: string;
  fragmentSource: string;
};

const REGENERATE_HINT =
  "Run `pnpm --filter @closedloop-ai/telemetry-contract generate:collector-posthog-routing` and commit the regenerated collector/ artifacts.";

export function evaluateCollectorPosthogRouting(
  input: EvaluateInput
): CollectorGuardFinding[] {
  // An empty marker set cannot produce a routing filter (the generator throws to
  // prevent a drop-everything fragment). Surface that as a finding rather than
  // letting the fresh-render comparison below throw — the guard's contract is to
  // return findings, never raise.
  if (input.expectedKeys.length === 0) {
    return [
      {
        file: CollectorPosthogRoutingPath.Manifest,
        message:
          "No product-signal markers are configured (CollectorProductSignalAttributeKeys is empty): a PostHog routing filter cannot be generated. Add at least one marker attribute to the contract.",
      },
    ];
  }

  const findings: CollectorGuardFinding[] = [];
  const expected = new Set(input.expectedKeys);
  const fresh = collectorPosthogRoutingArtifacts(input.expectedKeys);
  const identityManifestSource =
    input.identityManifestSource ?? fresh.identityManifestJson;
  const identityFragmentSource =
    input.identityFragmentSource ?? fresh.identityFragmentYaml;

  const manifestKeys = parseManifestMarkerKeys(input.manifestSource, findings);
  if (manifestKeys) {
    findings.push(
      ...diffFindings(
        CollectorPosthogRoutingPath.Manifest,
        expected,
        manifestKeys,
        POSTHOG_ROUTING_DIFF_MESSAGES
      )
    );
  }

  findings.push(...checkFragmentStructure(input.fragmentSource, expected));
  findings.push(
    ...checkIdentityManifestStructure(identityManifestSource),
    ...checkIdentityFragmentStructure(identityFragmentSource)
  );

  // Byte-identity against a fresh render catches header/formatting/ordering
  // drift that the structural checks alone would miss, and is the actionable
  // "you forgot to regenerate" signal.
  if (input.manifestSource !== fresh.manifestJson) {
    findings.push({
      file: CollectorPosthogRoutingPath.Manifest,
      message: `Committed manifest is not up to date with the telemetry contract. ${REGENERATE_HINT}`,
    });
  }
  if (input.fragmentSource !== fresh.fragmentYaml) {
    findings.push({
      file: CollectorPosthogRoutingPath.Fragment,
      message: `Committed PostHog routing fragment is not up to date with the telemetry contract. ${REGENERATE_HINT}`,
    });
  }
  if (identityManifestSource !== fresh.identityManifestJson) {
    findings.push({
      file: CollectorPosthogIdentityPath.Manifest,
      message: `Committed PostHog identity manifest is not up to date with the telemetry contract. ${REGENERATE_HINT}`,
    });
  }
  if (identityFragmentSource !== fresh.identityFragmentYaml) {
    findings.push({
      file: CollectorPosthogIdentityPath.Fragment,
      message: `Committed PostHog identity transform fragment is not up to date with the telemetry contract. ${REGENERATE_HINT}`,
    });
  }

  return findings;
}

function parseManifestMarkerKeys(
  source: string,
  findings: CollectorGuardFinding[]
): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    findings.push({
      file: CollectorPosthogRoutingPath.Manifest,
      message: `Manifest is not valid JSON: ${describeError(error)}. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    findings.push({
      file: CollectorPosthogRoutingPath.Manifest,
      message: `Manifest must be a JSON object. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  if (!isStringArray(parsed.markerKeys)) {
    findings.push({
      file: CollectorPosthogRoutingPath.Manifest,
      message: `Manifest "markerKeys" must be an array of strings. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  if (parsed.markerKeys.length === 0) {
    findings.push({
      file: CollectorPosthogRoutingPath.Manifest,
      message:
        'Manifest "markerKeys" must not be empty — a routing filter with no markers would drop every span.',
    });
  }

  return new Set(parsed.markerKeys);
}

function checkFragmentStructure(
  source: string,
  expected: ReadonlySet<string>
): CollectorGuardFinding[] {
  const file = CollectorPosthogRoutingPath.Fragment;
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    return [
      {
        file,
        message: `PostHog routing fragment is not valid YAML: ${describeError(error)}. ${REGENERATE_HINT}`,
      },
    ];
  }

  const processor = isRecord(parsed)
    ? parsed[POSTHOG_FILTER_PROCESSOR_NAME]
    : undefined;
  if (!isRecord(processor)) {
    return [
      {
        file,
        message: `PostHog routing fragment must define a "${POSTHOG_FILTER_PROCESSOR_NAME}" processor block. ${REGENERATE_HINT}`,
      },
    ];
  }

  const traces = isRecord(processor.traces) ? processor.traces : undefined;
  const spanConditions = traces?.span;
  if (!isStringArray(spanConditions) || spanConditions.length === 0) {
    return [
      {
        file,
        message: `PostHog routing fragment "${POSTHOG_FILTER_PROCESSOR_NAME}.traces.span" must be a non-empty list of OTTL conditions. ${REGENERATE_HINT}`,
      },
    ];
  }

  // Every marker key must be referenced by the drop condition, else a product
  // signal would be filtered out of (or a non-product span leaked into) the
  // PostHog leg. The generator emits each as `attributes["<key>"]`.
  const conditionText = spanConditions.join(" ");
  const missing = [...expected]
    .filter((key) => !conditionText.includes(`attributes["${key}"]`))
    .sort();
  if (missing.length > 0) {
    return [
      {
        file,
        message: `PostHog routing filter does not reference contract product-signal marker(s): ${missing.join(", ")}. ${REGENERATE_HINT}`,
      },
    ];
  }

  return [];
}

function checkIdentityManifestStructure(
  source: string
): CollectorGuardFinding[] {
  const file = CollectorPosthogIdentityPath.Manifest;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return [
      {
        file,
        message: `PostHog identity manifest is not valid JSON: ${describeError(error)}. ${REGENERATE_HINT}`,
      },
    ];
  }

  if (!isRecord(parsed)) {
    return [
      {
        file,
        message: `PostHog identity manifest must be a JSON object. ${REGENERATE_HINT}`,
      },
    ];
  }

  const findings: CollectorGuardFinding[] = [];
  if (parsed.sourceKey !== TelemetryAttribute.AppInstallationId) {
    findings.push({
      file,
      message: `PostHog identity manifest sourceKey must be "${TelemetryAttribute.AppInstallationId}". ${REGENERATE_HINT}`,
    });
  }
  if (parsed.targetKey !== PosthogIdentityAttribute.DistinctId) {
    findings.push({
      file,
      message: `PostHog identity manifest targetKey must be "${PosthogIdentityAttribute.DistinctId}". ${REGENERATE_HINT}`,
    });
  }
  if (parsed.processorName !== POSTHOG_IDENTITY_PROCESSOR_NAME) {
    findings.push({
      file,
      message: `PostHog identity manifest processorName must be "${POSTHOG_IDENTITY_PROCESSOR_NAME}". ${REGENERATE_HINT}`,
    });
  }
  return findings;
}

function checkIdentityFragmentStructure(
  source: string
): CollectorGuardFinding[] {
  const file = CollectorPosthogIdentityPath.Fragment;
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    return [
      {
        file,
        message: `PostHog identity transform fragment is not valid YAML: ${describeError(error)}. ${REGENERATE_HINT}`,
      },
    ];
  }

  const processor = isRecord(parsed)
    ? parsed[POSTHOG_IDENTITY_PROCESSOR_NAME]
    : undefined;
  if (!isRecord(processor)) {
    return [
      {
        file,
        message: `PostHog identity transform fragment must define a "${POSTHOG_IDENTITY_PROCESSOR_NAME}" processor block. ${REGENERATE_HINT}`,
      },
    ];
  }

  const statements = collectIdentityStatements(processor);
  const statementText = statements.join(" ");
  const findings: CollectorGuardFinding[] = [];
  if (
    !statementText.includes(
      `attributes["${TelemetryAttribute.AppInstallationId}"]`
    )
  ) {
    findings.push({
      file,
      message: `PostHog identity transform does not reference source key "${TelemetryAttribute.AppInstallationId}". ${REGENERATE_HINT}`,
    });
  }
  if (
    !statementText.includes(
      `attributes["${PosthogIdentityAttribute.DistinctId}"]`
    )
  ) {
    findings.push({
      file,
      message: `PostHog identity transform does not set target key "${PosthogIdentityAttribute.DistinctId}". ${REGENERATE_HINT}`,
    });
  }
  if (
    !statementText.includes(
      `where attributes["${TelemetryAttribute.AppInstallationId}"] != nil`
    )
  ) {
    findings.push({
      file,
      message: `PostHog identity transform must guard missing "${TelemetryAttribute.AppInstallationId}" values with a nil check. ${REGENERATE_HINT}`,
    });
  }
  return findings;
}

function collectIdentityStatements(
  processor: Record<string, unknown>
): string[] {
  const traceStatements = processor.trace_statements;
  if (!Array.isArray(traceStatements)) {
    return [];
  }
  return traceStatements.flatMap((entry) => {
    if (!(isRecord(entry) && isStringArray(entry.statements))) {
      return [];
    }
    return entry.statements;
  });
}

const POSTHOG_ROUTING_DIFF_MESSAGES = {
  missingMessage: (missing: string[]) =>
    `Contract product-signal marker(s) missing from the PostHog routing manifest (would not fan out to PostHog): ${missing.join(", ")}. ${REGENERATE_HINT}`,
  extraMessage: (extra: string[]) =>
    `PostHog routing manifest marker(s) not present in the telemetry contract (stale): ${extra.join(", ")}. ${REGENERATE_HINT}`,
};

export function runCollectorPosthogRoutingCheck(
  stderr: ConsoleErrorLike = console
): number {
  const findings = evaluateCollectorPosthogRouting({
    expectedKeys: CollectorProductSignalAttributeKeys,
    manifestSource: readCommittedArtifact(
      CollectorPosthogRoutingPath.Manifest,
      REGENERATE_HINT,
      stderr
    ),
    fragmentSource: readCommittedArtifact(
      CollectorPosthogRoutingPath.Fragment,
      REGENERATE_HINT,
      stderr
    ),
    identityManifestSource: readCommittedArtifact(
      CollectorPosthogIdentityPath.Manifest,
      REGENERATE_HINT,
      stderr
    ),
    identityFragmentSource: readCommittedArtifact(
      CollectorPosthogIdentityPath.Fragment,
      REGENERATE_HINT,
      stderr
    ),
  });

  for (const finding of findings) {
    stderr.error(
      `::error file=${repoRootAnnotationPath(finding.file)}::${finding.message}`
    );
  }

  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("check-collector-posthog-routing.ts")) {
  process.exitCode = runCollectorPosthogRoutingCheck();
}
