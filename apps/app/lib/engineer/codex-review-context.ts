import type { ReviewFinding, ReviewFindings } from "./codex-review-parser";

/**
 * Format the initial prompt sent to Claude when discussing review findings.
 * Review data is wrapped in <context> blocks (hidden in the UI) so the
 * visible message is just the analysis instruction.
 */
export function formatReviewContextForChat(
  findings: ReviewFindings,
  rawOutput: string,
  modelName: string
): string {
  const parts: string[] = [];

  parts.push("<context>");
  parts.push(`Review performed by model: ${modelName}`);
  parts.push(
    `\n## Raw Codex Review Output\n\`\`\`\n${rawOutput.slice(-8000)}\n\`\`\``
  );

  if (findings.findings.length > 0) {
    parts.push("\n## Parsed Findings\n");
    for (const finding of findings.findings) {
      const location = finding.file
        ? finding.line
          ? `${finding.file}:${finding.line}`
          : finding.file
        : "";
      const severity = finding.severity.toUpperCase();
      parts.push(
        `- **[${severity}]** ${location ? `(${location}) ` : ""}${finding.message}`
      );
      if (finding.suggestion) {
        parts.push(`  - Suggestion: ${finding.suggestion}`);
      }
    }
  }

  parts.push("</context>\n");

  parts.push(
    "Analyze the Codex code review findings. Read the referenced source files and assess whether each finding is valid or a false positive. If the issue is valid, suggest a concrete fix."
  );
  parts.push("");
  parts.push(
    "If you think a finding might be wrong, or if you're uncertain and want a second opinion, you can initiate a structured debate with Codex. The goal of the debate is for two LLMs to examine the issue from different angles and converge on the correct answer — not to win an argument."
  );
  parts.push("");
  parts.push("Include this action to start a debate:");
  parts.push(
    `<action label="Debate Codex">argue_codex:[brief finding summary]</action>`
  );
  parts.push("");
  parts.push(
    `The "argue_codex:" prefix signals the UI to initiate a debate with Codex rather than sending a regular message. Replace [brief finding summary] with a concise description of the finding being examined.`
  );
  parts.push("");
  parts.push(
    "After your analysis, include suggested action buttons for logical next steps using the <suggested-actions> format."
  );

  return parts.join("\n");
}

/**
 * Format the initial prompt sent to Claude when discussing a single finding.
 * Provides focused context on one specific finding for per-finding chat.
 */
export function formatFindingContextForChat(
  finding: ReviewFinding,
  findingIndex: number,
  rawOutput: string,
  modelName: string
): string {
  const parts: string[] = [];

  parts.push("<context>");
  parts.push(`Review performed by model: ${modelName}`);
  parts.push(`Finding #${findingIndex + 1}`);

  const location = finding.file
    ? finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file
    : "";
  const severity = finding.severity.toUpperCase();
  const priority = finding.priority || "";

  parts.push("\n## Finding Details");
  parts.push(`- **Severity:** ${severity}`);
  if (priority) {
    parts.push(`- **Priority:** ${priority}`);
  }
  if (location) {
    parts.push(`- **Location:** ${location}`);
  }
  parts.push(`- **Message:** ${finding.message}`);
  if (finding.suggestion) {
    parts.push(`- **Suggestion:** ${finding.suggestion}`);
  }

  parts.push(
    "\n## Raw Codex Review Output (reference)\n```\n" +
      rawOutput.slice(-8000) +
      "\n```"
  );
  parts.push("</context>\n");

  parts.push(
    "Analyze this specific code review finding from OpenAI Codex. " +
      "Read the referenced source files and assess whether this finding is valid or a false positive. " +
      "If the issue is valid, suggest a concrete fix with code examples.",
    "",
    "After your analysis, include suggested action buttons using the <suggested-actions> format. Choose actions based on your verdict:",
    "",
    "**If the finding is VALID (you agree with Codex):** offer actions like:",
    "<suggested-actions>",
    `<action label="Apply Fix">Apply the suggested fix for this finding</action>`,
    `<action label="Dismiss Finding">/dismiss</action>`,
    "</suggested-actions>",
    "",
    "**If the finding is INVALID or you're UNCERTAIN:** offer the debate action so the user can get a second opinion from Codex:",
    "<suggested-actions>",
    `<action label="Debate Codex">argue_codex:${finding.message.split("\n")[0].slice(0, 80)}</action>`,
    `<action label="Dismiss Finding">/dismiss</action>`,
    "</suggested-actions>",
    "",
    `The "argue_codex:" prefix signals the UI to initiate a structured debate with Codex. Only include it when you disagree with or are uncertain about the finding.`,
    "",
    '**After applying code changes** (e.g. the user clicked "Apply Fix" and you made edits), always offer a "Dismiss Finding" action so the user can close the resolved finding:',
    "<suggested-actions>",
    `<action label="Dismiss Finding">/dismiss</action>`,
    "</suggested-actions>"
  );

  return parts.join("\n");
}
