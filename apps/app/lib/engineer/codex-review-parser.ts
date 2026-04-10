/**
 * Split a finding message into title (first line, with location annotations stripped)
 * and description (remaining lines joined).
 */
export function parseFindingTitle(message: string): {
  title: string;
  description: string;
} {
  const parts = message.split(/\n/);
  const titleRaw = parts[0];
  const description = parts.slice(1).join(" ").trim();
  const title = titleRaw
    .replaceAll(/\s*—\s*\S+:\d+[-–]\d+/g, "")
    .replaceAll(/\s*—\s*\S+:\d+/g, "")
    .trim();
  return { title, description };
}

export type ReviewFinding = {
  severity: "critical" | "warning" | "info" | "success";
  priority?: "P0" | "P1" | "P2" | "P3";
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  // Natural-voice PR comment body generated during extraction.
  // Rendered in the chat UI in place of the structured description/suggestion.
  // Also used by buildCommentBody when posting as a PR comment.
  humanizedBody?: string;
};

export type ReviewFindings = {
  summary: string;
  findings: ReviewFinding[];
  approved: boolean;
  verdict?: ReviewVerdict;
};

/**
 * Strip the codex CLI preamble (version info, session metadata, deprecation warnings)
 * from the output, returning only the actual review content.
 */
function stripCodexPreamble(output: string): string {
  // Look for the review content after the preamble.
  // Codex outputs metadata lines like "OpenAI Codex v...", "workdir:", "model:", etc.
  // followed by "--------" separators. The actual review starts after the last separator block.

  // Split on the "--------" separator pattern
  const separatorPattern = /-{6,}/;
  const parts = output.split(separatorPattern);

  // If we found separators, the review content is after the last one
  if (parts.length >= 3) {
    // Take everything after the second separator (skip preamble + config sections)
    return parts.slice(2).join("--------").trim();
  }

  // Fallback: try to find where the actual review starts
  const reviewStart =
    /^(Review comment|## |# |LGTM|Approved|Changes reviewed|Code review)/im.exec(
      output
    );
  if (reviewStart) {
    return output.slice(reviewStart.index).trim();
  }

  return output;
}

/**
 * Parse codex review output into structured findings.
 *
 * Handles formats:
 * - Priority markers: "- [P0]", "- [P1]", "- [P2]", "- [P3]"
 * - Severity markers: "critical:", "warning:", "info:"
 * - Emoji markers: "❌", "⚠️", "ℹ️", "✓", "✅"
 * - "## Summary" sections
 * - File:line references like "src/api.ts:42"
 */
export function parseCodexReviewOutput(rawOutput: string): ReviewFindings {
  const output = stripCodexPreamble(rawOutput);
  const lines = output.split("\n");
  const findings: ReviewFinding[] = [];
  let summary = "";
  let approved = true;
  let inSummary = false;
  const summaryLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect summary section
    if (/^##?\s*summary/i.exec(trimmed)) {
      inSummary = true;
      continue;
    }

    // End summary section on next header
    if (inSummary && /^##/.exec(trimmed)) {
      inSummary = false;
      summary = summaryLines.join("\n").trim();
    }

    if (inSummary) {
      summaryLines.push(trimmed);
      continue;
    }

    // Parse finding lines
    const finding = parseFindingLine(trimmed, lines, i);
    if (finding) {
      findings.push(finding);
      if (finding.severity === "critical") {
        approved = false;
      }
    }

    // Check for explicit approval/rejection
    if (
      /\b(rejected|fail|failed|not approved)\b/i.exec(trimmed) &&
      !/\b(if|would|could|might)\b/i.exec(trimmed)
    ) {
      approved = false;
    }
  }

  // Close dangling summary section
  if (inSummary && summaryLines.length > 0) {
    summary = summaryLines.join("\n").trim();
  }

  // If we didn't find a summary section, generate one from findings
  if (!summary) {
    if (findings.length > 0) {
      const critical = findings.filter((f) => f.severity === "critical").length;
      const warnings = findings.filter((f) => f.severity === "warning").length;
      const info = findings.filter((f) => f.severity === "info").length;
      const parts: string[] = [];
      if (critical > 0) {
        parts.push(`${critical} critical`);
      }
      if (warnings > 0) {
        parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
      }
      if (info > 0) {
        parts.push(`${info} suggestion${info > 1 ? "s" : ""}`);
      }
      summary = `Found ${parts.join(", ")} across ${findings.length} item${findings.length > 1 ? "s" : ""}.`;
    } else {
      summary = "No issues found.";
    }
  }

  return { summary, findings, approved, verdict: extractVerdictTag(rawOutput) };
}

function priorityToSeverity(priority: string): ReviewFinding["severity"] {
  switch (priority.toUpperCase()) {
    case "P0":
      return "critical";
    case "P1":
      return "critical";
    case "P2":
      return "warning";
    case "P3":
      return "info";
    default:
      return "info";
  }
}

function parseFindingLine(
  line: string,
  allLines: string[],
  index: number
): ReviewFinding | null {
  // Priority format: "- [P0] message", "- [P1] message", etc.
  const priorityMatch = /^[-*]\s+\[([Pp]\d)\]\s+(.+)/.exec(line);
  if (priorityMatch) {
    const severity = priorityToSeverity(priorityMatch[1]);
    const priority =
      priorityMatch[1].toUpperCase() as ReviewFinding["priority"];
    return createFindingFromContent(
      severity,
      priorityMatch[2],
      allLines,
      index,
      priority
    );
  }

  // Critical patterns
  if (/^(❌|🔴|\[critical\]|critical:)/i.exec(line)) {
    return createFinding("critical", line, allLines, index);
  }

  // Warning patterns
  if (/^(⚠️|🟡|🟠|\[warning\]|warning:)/i.exec(line)) {
    return createFinding("warning", line, allLines, index);
  }

  // Info patterns
  if (/^(ℹ️|🔵|\[info\]|info:|note:)/i.exec(line)) {
    return createFinding("info", line, allLines, index);
  }

  // Success patterns
  if (/^(✓|✅|🟢|\[success\]|lgtm)/i.exec(line)) {
    return createFinding("success", line, allLines, index);
  }

  // Bullet points with severity keywords
  if (/^[-*]\s+/.exec(line)) {
    if (/\b(critical|severe|security|vulnerability)\b/i.exec(line)) {
      return createFinding("critical", line, allLines, index);
    }
    if (/\b(warning|warn|caution|potential issue)\b/i.exec(line)) {
      return createFinding("warning", line, allLines, index);
    }
    if (/\b(suggestion|consider|recommend|might want)\b/i.exec(line)) {
      return createFinding("info", line, allLines, index);
    }
  }

  return null;
}

function extractFileRef(text: string): { file?: string; line?: number } {
  // Match patterns like "file.tsx:42" or "path/to/file.ts:100-200"
  const fileMatch = /\b([\w./-]+\.[a-z]{1,4}):(\d+)/i.exec(text);
  return {
    file: fileMatch?.[1],
    line: fileMatch?.[2] ? Number.parseInt(fileMatch[2], 10) : undefined,
  };
}

function collectIndentedBody(allLines: string[], startIndex: number): string {
  // Collect indented continuation lines after a finding
  const bodyLines: string[] = [];
  for (let j = startIndex + 1; j < allLines.length; j++) {
    const next = allLines[j];
    // Stop at empty lines, new bullet points, or non-indented lines
    if (
      !next.trim() ||
      /^[-*]\s+\[?[Pp]\d/.exec(next.trim()) ||
      /^[-*]\s+[❌⚠️ℹ️✓✅🔴🟡🟠🔵🟢]/.exec(next.trim())
    ) {
      break;
    }
    // Only include lines that are indented (continuation of the finding)
    if (/^\s{2,}/.exec(next)) {
      bodyLines.push(next.trim());
    } else {
      break;
    }
  }
  return bodyLines.join(" ");
}

function createFindingFromContent(
  severity: ReviewFinding["severity"],
  content: string,
  allLines: string[],
  index: number,
  priority?: ReviewFinding["priority"]
): ReviewFinding {
  const { file, line } = extractFileRef(content);

  // The message is the content, possibly with a file reference stripped for cleanliness
  // But keep it readable — include file context in the message
  const body = collectIndentedBody(allLines, index);
  const message = body ? `${content.trim()}\n${body}` : content.trim();

  return { severity, file, line, message, ...(priority ? { priority } : {}) };
}

function createFinding(
  severity: ReviewFinding["severity"],
  line: string,
  allLines: string[],
  index: number
): ReviewFinding {
  const { file, line: lineNum } = extractFileRef(line);

  // Clean up the message
  const message = line
    .replaceAll(/^(❌|⚠️|ℹ️|✓|✅|🔴|🟡|🟠|🔵|🟢)\s*/g, "")
    .replaceAll(/^\[(critical|warning|info|success)\]\s*/gi, "")
    .replaceAll(/^(critical|warning|info|note):\s*/gi, "")
    .replaceAll(/^[-*]\s+/g, "")
    .trim();

  // Check next line for suggestion
  let suggestion: string | undefined;
  if (index + 1 < allLines.length) {
    const nextLine = allLines[index + 1].trim();
    if (/^(→|->|suggestion:|fix:|consider:)/i.exec(nextLine)) {
      suggestion = nextLine
        .replaceAll(/^(→|->)\s*/g, "")
        .replaceAll(/^(suggestion|fix|consider):\s*/gi, "")
        .trim();
    }
  }

  return { severity, file, line: lineNum, message, suggestion };
}

// ---- Claude review parser ----

const ISSUES_SECTION_RE =
  /^#{2,4}\s*(?:Issues?\s*(?:&|and)\s*Suggestions?|Findings?|Issues?|Problems?)\s*$/im;
const SEVERITY_SECTION_RE =
  /^#{2,5}\s*(Critical|High|Medium|Low)\s*(?:Severity)?\s*$/i;
const END_SECTION_RE =
  /^#{2,4}\s*(?:Positive\s+Observations?|Summary|Conclusion|Overall|Recommendations?)\s*$/im;
const NUMBERED_ITEM_RE = /^(\d+)\.\s+/;

function severityLabelToLevel(label: string): ReviewFinding["severity"] {
  const lower = label.toLowerCase();
  if (lower === "critical" || lower === "high") {
    return "critical";
  }
  if (lower === "medium") {
    return "warning";
  }
  return "info";
}

function severityToPriority(
  severity: ReviewFinding["severity"]
): ReviewFinding["priority"] {
  if (severity === "critical") {
    return "P1";
  }
  if (severity === "warning") {
    return "P2";
  }
  return "P3";
}

/**
 * Parse Claude's review output into structured findings.
 *
 * Tries JSON extraction first (from a ```json code block at the end of the review),
 * then falls back to markdown regex parsing. The JSON approach is more reliable since
 * Claude's markdown format varies between reviews.
 */
export function parseClaudeReviewOutput(output: string): {
  processLog: string;
  findings: ReviewFinding[];
} {
  // Try JSON extraction first — deterministic and format-independent
  const jsonResult = extractJsonFindings(output);
  if (jsonResult) {
    return jsonResult;
  }

  // Fall back to markdown regex parsing
  return parseClaudeMarkdownFindings(output);
}

type StructuredJsonFinding = {
  severity?: string;
  file?: string;
  line?: number | null;
  title?: string;
  description?: string;
  suggestion?: string | null;
};

// Matches any heading that starts an "issues" section — used to split processLog from findings text
const ISSUES_HEADING_RE =
  /^#{2,4}\s*(?:Issues?\b|Findings?\b|Problems?\b|Critical\b|High\b)/im;

function extractJsonFindings(
  output: string
): { processLog: string; findings: ReviewFinding[] } | null {
  const codeBlockMatch = /```json\s*\n([\s\S]*?)\n\s*```/.exec(output);
  if (!codeBlockMatch) {
    return null;
  }

  let parsed: StructuredJsonFinding[];
  try {
    parsed = JSON.parse(codeBlockMatch[1]);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  // processLog = preamble only (before the issues section), not the full markdown review.
  // Try to find where the issues/findings section starts; fall back to everything before the JSON block.
  const beforeJson = output.slice(0, codeBlockMatch.index);
  const issuesStart = ISSUES_HEADING_RE.exec(beforeJson);
  const processLog = issuesStart
    ? beforeJson.slice(0, issuesStart.index).trim()
    : beforeJson.trim();

  const findings: ReviewFinding[] = parsed.map((item) => {
    const severity = severityLabelToLevel(item.severity ?? "low");
    return {
      severity,
      priority: severityToPriority(severity),
      file: item.file ?? undefined,
      line: item.line ?? undefined,
      message: item.description
        ? `${item.title ?? ""}\n${item.description}`
        : (item.title ?? ""),
      suggestion: item.suggestion ?? undefined,
    };
  });

  return { processLog, findings };
}

function parseClaudeMarkdownFindings(output: string): {
  processLog: string;
  findings: ReviewFinding[];
} {
  const issuesMatch = ISSUES_SECTION_RE.exec(output);
  if (!issuesMatch) {
    return { processLog: output, findings: [] };
  }

  const processLog = output.slice(0, issuesMatch.index).trim();
  const afterHeader = output.slice(issuesMatch.index + issuesMatch[0].length);

  // Find where the issues section ends
  const endMatch = END_SECTION_RE.exec(afterHeader);
  const issuesText = endMatch
    ? afterHeader.slice(0, endMatch.index).trim()
    : afterHeader.trim();

  return { processLog, findings: parseClaudeFindings(issuesText) };
}

function parseClaudeFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let currentSeverity: ReviewFinding["severity"] = "warning";

  // Split into lines and iterate
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for severity section headers
    const sevMatch = SEVERITY_SECTION_RE.exec(trimmed);
    if (sevMatch) {
      currentSeverity = severityLabelToLevel(sevMatch[1]);
      i++;
      continue;
    }

    // Check for numbered items
    const numMatch = NUMBERED_ITEM_RE.exec(trimmed);
    if (!numMatch) {
      i++;
      continue;
    }

    const content = trimmed.slice(numMatch[0].length);

    // Extract file reference from backtick-wrapped or bold ref: `file:lines` — Title
    const fileRefMatch = /^[`*]+([^`*]+?)[`*]+\s*(?:—|--)\s*(.+)/.exec(content);

    let file: string | undefined;
    let lineNum: number | undefined;
    let title: string;

    if (fileRefMatch) {
      const fileRef = fileRefMatch[1];
      title = fileRefMatch[2].trim();
      const fileLineMatch = /^(.+?):(\d+)(?:-\d+)?$/.exec(fileRef);
      if (fileLineMatch) {
        file = fileLineMatch[1];
        lineNum = Number.parseInt(fileLineMatch[2], 10);
      } else {
        file = fileRef;
      }
    } else {
      title = content;
      // Try to find file ref inline
      const inlineRef = /\b([\w./-]+\.[a-z]{1,4}):(\d+)/i.exec(content);
      if (inlineRef) {
        file = inlineRef[1];
        lineNum = Number.parseInt(inlineRef[2], 10);
      }
    }

    // Collect continuation lines until next numbered item or section header
    i++;
    const descParts: string[] = [];
    while (i < lines.length) {
      const nextTrimmed = lines[i].trim();
      if (
        NUMBERED_ITEM_RE.exec(nextTrimmed) ||
        SEVERITY_SECTION_RE.exec(nextTrimmed) ||
        END_SECTION_RE.exec(nextTrimmed)
      ) {
        break;
      }
      // Skip blank lines but still collect continuation text
      if (nextTrimmed) {
        descParts.push(nextTrimmed);
      }
      i++;
    }

    const description = descParts.join("\n");
    const message = description ? `${title}\n${description}` : title;

    findings.push({
      severity: currentSeverity,
      priority: severityToPriority(currentSeverity),
      file,
      line: lineNum,
      message,
    });
  }

  return findings;
}

export type ReviewVerdict = {
  verdict: "decline" | "needs_attention" | "approve";
  reason: string;
};

const VERDICT_TAG_RE = /<pr_verdict>([\s\S]*?)<\/pr_verdict>/;
const VALID_VERDICTS = new Set(["decline", "needs_attention", "approve"]);

export function extractVerdictTag(
  rawOutput: string
): ReviewVerdict | undefined {
  const match = VERDICT_TAG_RE.exec(rawOutput);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      typeof parsed.verdict !== "string" ||
      !VALID_VERDICTS.has(parsed.verdict) ||
      typeof parsed.reason !== "string" ||
      parsed.reason.length === 0
    ) {
      return undefined;
    }
    return {
      verdict: parsed.verdict as ReviewVerdict["verdict"],
      reason: parsed.reason,
    };
  } catch {
    return undefined;
  }
}
