/**
 * Canonical property labels expected across cloud and Desktop session detail
 * tests for the Claude Code session detail contract.
 */
export const EXPECTED_CLAUDE_CODE_PROPERTY_LABELS = [
  "Status",
  "Harness",
  "Session ID",
  "Repository",
  "Duration",
  "Tokens",
  "Autonomy",
  "Model",
  "Branch",
  "Pull requests",
  "Cost",
  "Work",
] as const;

/**
 * Asserts that a rendered property label list exactly matches the shared
 * Claude Code detail contract, including order and omissions.
 */
export function expectExactClaudeCodePropertyLabels(labels: readonly string[]) {
  if (
    labels.length !== EXPECTED_CLAUDE_CODE_PROPERTY_LABELS.length ||
    labels.some(
      (label, index) => label !== EXPECTED_CLAUDE_CODE_PROPERTY_LABELS[index]
    )
  ) {
    throw new Error(
      `Expected exact Claude Code property labels ${JSON.stringify(
        EXPECTED_CLAUDE_CODE_PROPERTY_LABELS
      )}, received ${JSON.stringify(labels)}`
    );
  }
}
