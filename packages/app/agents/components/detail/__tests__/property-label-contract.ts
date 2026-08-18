/**
 * Canonical property labels expected across cloud and Desktop session detail
 * tests for the Claude Code session detail contract.
 */
export const EXPECTED_CLAUDE_CODE_PROPERTY_LABELS = [
  "Status",
  // FEA-3529 (gate retired by ISS-5366, shipped ON): the transcript
  // sync-state row, right after Status. It renders whenever the session
  // carries a resolvable sync verdict — a version-skewed producer that omits
  // both `transcriptDisposition` and `lastSyncedAt` still drops the row rather
  // than showing an empty labeled one, so a fixture without those fields will
  // not list it here.
  "Sync",
  // FEA-3330 / FEA-3725: session owner, always shown right after Status. Null
  // owners render an em-dash rather than dropping the row, so the label is
  // unconditionally present.
  "Owner",
  "Harness",
  "Session ID",
  "Repository",
  "Duration",
  "Tokens",
  "Autonomy",
  "Model",
  "Branch",
  "Pull requests",
  // FEA-4378: the session's lines-changed figure — its own labeled row (moved out
  // of the "Pull requests" pills row so a number after the pills is never misread
  // as "LOC for those PRs"). Shows the +added/-removed working-tree diff, or the
  // summed authored-PR roll-up qualified "in PRs" when that is the larger figure.
  "Lines changed",
  "Cost",
  // FEA-3630: per-session LOC/$ cost-efficiency row, rendered next to Cost.
  "LOC / $",
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
