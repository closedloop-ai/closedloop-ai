import type {
  AgentCoachingAction,
  AgentCoachingTip,
} from "./agent-coaching-types";

/**
 * Turn a tip + action into the concrete artifact the action promises — a
 * ready-to-paste prompt / skill / workflow spec in Markdown. This is what makes
 * the action buttons actually *do* something: `read_only` and `draft` actions
 * produce this text in the renderer (shown + copied to the clipboard);
 * `confirm_then_apply` hands the same text to the desktop write operation.
 */
export function buildActionDraft(
  tip: AgentCoachingTip,
  action: AgentCoachingAction
): string {
  // When the generator supplied the real artifact, that IS the draft — show it
  // verbatim so the user reviews exactly what will be installed.
  if (tip.proposedArtifact?.trim()) {
    return tip.proposedArtifact;
  }
  // Fallback (heuristic seed tips with no artifact): synthesize a plausible
  // starting point from the tip's fields.
  const lines: string[] = [
    `# ${action.label} — ${tip.title}`,
    "",
    tip.body,
    "",
    "## Why this matters",
    tip.whyItMatters,
    "",
    "## Steps",
    ...tip.detail.howToAct.map((step) => `- ${step}`),
    "",
    "## Experiment",
    tip.experiment,
  ];

  const candidate = tip.detail.candidateFromThisDryRun;
  if (candidate) {
    lines.push(
      "",
      "## Reusable skill candidate",
      candidate.suggestedWrapper,
      "",
      "### Output contract",
      ...candidate.outputContract.map((item) => `- ${item}`)
    );
    if (candidate.representativeCommands.length > 0) {
      lines.push(
        "",
        "### Representative commands",
        ...candidate.representativeCommands.map((command) => `- \`${command}\``)
      );
    }
  }

  return lines.join("\n");
}
