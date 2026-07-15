import { readFileSync } from "node:fs";
import YAML from "yaml";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import type { CollectorGuardFinding } from "./collector-codegen-common";
import {
  type ConsoleErrorLike,
  describeError,
  isRecord,
  repoRootAnnotationPath,
} from "./collector-codegen-common";
import {
  CollectorTailSamplingPath,
  collectorTailSamplingArtifacts,
  REGENERATE_COMMAND,
} from "./generate-collector-tail-sampling";

/**
 * C4 drift guard (FEA-1992): fail the build when the committed collector
 * `tail_sampling` fragment no longer matches the policy SSOT. The fragment is
 * vendored cross-repo into the cl-tofu collector config, so a hand-edit that
 * silently diverges from the contract is exactly the failure mode to catch.
 *
 * `evaluateCollectorTailSampling` is pure so it is unit-testable without disk;
 * the CLI wrapper reads the committed artifact and emits GitHub annotations.
 */

type EvaluateInput = {
  fragmentSource: string;
};

const REGENERATE_HINT = `Run \`${REGENERATE_COMMAND}\` and commit the regenerated collector/ artifact.`;

export function evaluateCollectorTailSampling(
  input: EvaluateInput
): CollectorGuardFinding[] {
  // Structural sanity first: the committed fragment must parse and carry a
  // `tail_sampling` block with at least one policy. This catches a corrupt or
  // truncated commit with a clearer message than the byte diff alone.
  const findings: CollectorGuardFinding[] = [];
  validateFragmentStructure(input.fragmentSource, findings);

  // A structurally invalid fragment is already actionable; the byte-identity
  // diff against a fresh render would always also fire here, so reporting it
  // too would be redundant, misleading noise. Only run the drift check once the
  // fragment is well-formed — then it is the actionable "you forgot to
  // regenerate" signal, catching policy, ordering, and formatting drift the
  // structural parse would miss.
  if (findings.length > 0) {
    return findings;
  }

  const { fragmentYaml } = collectorTailSamplingArtifacts();
  if (input.fragmentSource !== fragmentYaml) {
    findings.push({
      file: CollectorTailSamplingPath.Fragment,
      message: `Committed tail-sampling fragment is not up to date with the policy SSOT. ${REGENERATE_HINT}`,
    });
  }

  return findings;
}

function validateFragmentStructure(
  source: string,
  findings: CollectorGuardFinding[]
): void {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    findings.push({
      file: CollectorTailSamplingPath.Fragment,
      message: `Tail-sampling fragment is not valid YAML: ${describeError(error)}. ${REGENERATE_HINT}`,
    });
    return;
  }

  const tailSampling = isRecord(parsed) ? parsed.tail_sampling : undefined;
  if (!isRecord(tailSampling)) {
    findings.push({
      file: CollectorTailSamplingPath.Fragment,
      message: `Tail-sampling fragment must define a "tail_sampling" processor block. ${REGENERATE_HINT}`,
    });
    return;
  }

  const policies = tailSampling.policies;
  if (!(Array.isArray(policies) && policies.length > 0)) {
    findings.push({
      file: CollectorTailSamplingPath.Fragment,
      message: `Tail-sampling fragment "policies" must be a non-empty list. ${REGENERATE_HINT}`,
    });
    return;
  }

  // Defence in depth: the baseline probabilistic policy is the only thing that
  // can drop traces — its absence would silently make sampling a no-op (100%
  // retention, zero cost saving). Assert it is present and named as expected.
  const hasBaseline = policies.some(
    (policy) =>
      isRecord(policy) &&
      policy.type === "probabilistic" &&
      policy.name === CollectorTailSamplingPolicy.policyNames.baseline
  );
  if (!hasBaseline) {
    findings.push({
      file: CollectorTailSamplingPath.Fragment,
      message: `Tail-sampling fragment is missing the "${CollectorTailSamplingPolicy.policyNames.baseline}" probabilistic policy (sampling would be a no-op). ${REGENERATE_HINT}`,
    });
  }
}

export function runCollectorTailSamplingCheck(
  stderr: ConsoleErrorLike = console
): number {
  const findings = evaluateCollectorTailSampling({
    fragmentSource: readSource(CollectorTailSamplingPath.Fragment, stderr),
  });

  for (const finding of findings) {
    stderr.error(
      `::error file=${repoRootAnnotationPath(finding.file)}::${finding.message}`
    );
  }

  return findings.length === 0 ? 0 : 1;
}

function readSource(path: string, stderr: ConsoleErrorLike): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    stderr.error(
      `::error file=${repoRootAnnotationPath(path)}::Unable to read committed collector artifact: ${describeError(error)}. ${REGENERATE_HINT}`
    );
    // A missing/unreadable artifact is itself drift: an empty source cannot
    // match a fresh render, so evaluation fails.
    return "";
  }
}

if (process.argv[1]?.endsWith("check-collector-tail-sampling.ts")) {
  process.exitCode = runCollectorTailSamplingCheck();
}
