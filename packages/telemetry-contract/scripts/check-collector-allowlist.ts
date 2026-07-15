import YAML from "yaml";
import { CollectorAllowedAttributeKeys } from "../src/attributes";
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
  CollectorAllowlistPath,
  collectorAllowlistArtifacts,
} from "./generate-collector-allowlist";

/**
 * O1 drift guard (FEA-2170): fail the build when the committed collector
 * allow-list artifacts no longer match the contract's `TelemetryAttribute`
 * SSOT. This turns a silently-dropped telemetry attribute (the failure mode
 * PRD-389/429 set out to prevent) into a red build.
 *
 * `evaluateCollectorAllowlist` is pure so it is unit-testable without disk; the
 * CLI wrapper reads the committed artifacts and emits GitHub error annotations.
 */

type EvaluateInput = {
  expectedKeys: readonly string[];
  manifestSource: string;
  fragmentSource: string;
};

const REGENERATE_HINT =
  "Run `pnpm --filter @closedloop-ai/telemetry-contract generate:collector-allowlist` and commit the regenerated collector/ artifacts.";

export function evaluateCollectorAllowlist(
  input: EvaluateInput
): CollectorGuardFinding[] {
  const findings: CollectorGuardFinding[] = [];
  const expected = new Set(input.expectedKeys);

  const manifestKeys = parseManifestAllowedKeys(input.manifestSource, findings);
  if (manifestKeys) {
    findings.push(
      ...diffFindings(
        CollectorAllowlistPath.Manifest,
        expected,
        manifestKeys,
        ALLOWLIST_DIFF_MESSAGES
      )
    );
  }

  const fragmentKeys = parseFragmentAllowedKeys(input.fragmentSource, findings);
  if (fragmentKeys) {
    findings.push(
      ...diffFindings(
        CollectorAllowlistPath.Fragment,
        expected,
        fragmentKeys,
        ALLOWLIST_DIFF_MESSAGES
      )
    );
  }

  // Byte-identity against a fresh render catches header/formatting/ordering
  // drift that the set comparison alone would miss, and is the actionable
  // "you forgot to regenerate" signal.
  const fresh = collectorAllowlistArtifacts(input.expectedKeys);
  if (input.manifestSource !== fresh.manifestJson) {
    findings.push({
      file: CollectorAllowlistPath.Manifest,
      message: `Committed manifest is not up to date with the telemetry contract. ${REGENERATE_HINT}`,
    });
  }
  if (input.fragmentSource !== fresh.fragmentYaml) {
    findings.push({
      file: CollectorAllowlistPath.Fragment,
      message: `Committed redaction fragment is not up to date with the telemetry contract. ${REGENERATE_HINT}`,
    });
  }

  return findings;
}

function parseManifestAllowedKeys(
  source: string,
  findings: CollectorGuardFinding[]
): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    findings.push({
      file: CollectorAllowlistPath.Manifest,
      message: `Manifest is not valid JSON: ${describeError(error)}. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    findings.push({
      file: CollectorAllowlistPath.Manifest,
      message: `Manifest must be a JSON object. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  if (parsed.allowAllKeys !== false) {
    findings.push({
      file: CollectorAllowlistPath.Manifest,
      message: 'Manifest must set "allowAllKeys": false (deny-by-default).',
    });
  }

  if (!isStringArray(parsed.allowedKeys)) {
    findings.push({
      file: CollectorAllowlistPath.Manifest,
      message: `Manifest "allowedKeys" must be an array of strings. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  return new Set(parsed.allowedKeys);
}

function parseFragmentAllowedKeys(
  source: string,
  findings: CollectorGuardFinding[]
): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    findings.push({
      file: CollectorAllowlistPath.Fragment,
      message: `Redaction fragment is not valid YAML: ${describeError(error)}. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  const redaction = isRecord(parsed) ? parsed.redaction : undefined;
  if (!isRecord(redaction)) {
    findings.push({
      file: CollectorAllowlistPath.Fragment,
      message: `Redaction fragment must define a "redaction" processor block. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  if (redaction.allow_all_keys !== false) {
    findings.push({
      file: CollectorAllowlistPath.Fragment,
      message:
        'Redaction fragment must set "allow_all_keys: false" (deny-by-default).',
    });
  }

  if (!isStringArray(redaction.allowed_keys)) {
    findings.push({
      file: CollectorAllowlistPath.Fragment,
      message: `Redaction fragment "allowed_keys" must be a list of strings. ${REGENERATE_HINT}`,
    });
    return undefined;
  }

  return new Set(redaction.allowed_keys);
}

const ALLOWLIST_DIFF_MESSAGES = {
  missingMessage: (missing: string[]) =>
    `Telemetry contract attribute(s) not reflected in the collector allow-list (silently dropped): ${missing.join(", ")}. ${REGENERATE_HINT}`,
  extraMessage: (extra: string[]) =>
    `Collector allow-list key(s) not present in the telemetry contract (stale): ${extra.join(", ")}. ${REGENERATE_HINT}`,
};

export function runCollectorAllowlistCheck(
  stderr: ConsoleErrorLike = console
): number {
  const findings = evaluateCollectorAllowlist({
    expectedKeys: CollectorAllowedAttributeKeys,
    manifestSource: readCommittedArtifact(
      CollectorAllowlistPath.Manifest,
      REGENERATE_HINT,
      stderr
    ),
    fragmentSource: readCommittedArtifact(
      CollectorAllowlistPath.Fragment,
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

if (process.argv[1]?.endsWith("check-collector-allowlist.ts")) {
  process.exitCode = runCollectorAllowlistCheck();
}
