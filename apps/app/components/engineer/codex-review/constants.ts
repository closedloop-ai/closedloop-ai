import { DEFAULT_CODEX_MODEL as DEFAULT_CODEX_MODEL_BASE } from "@/lib/engineer/codex-models";
import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";

export const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODEL_BASE;

export const MODELS = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
];

export const REASONING_LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

export const CLAUDE_MODELS = [
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
];

export const LOCAL_STORAGE_KEYS = {
  model: "codex-review-model",
  reasoning: "codex-review-reasoning",
  provider: "codex-review-provider",
};

export const PRIORITY_ORDER = ["P0", "P1", "P2", "P3"] as const;

export const PRIORITY_LABELS: Record<string, string> = {
  P0: "Blocker",
  P1: "Critical",
  P2: "Warning",
  P3: "Suggestion",
};

/**
 * Persists across Dialog unmount/remount so "Start New Review" intent survives close/reopen
 */
export const pendingNewReview = new Set<string>();

/**
 * Map severity to a fallback priority when none is explicitly set
 */
export function severityToPriority(
  severity: ReviewFinding["severity"]
): string {
  switch (severity) {
    case "critical":
      return "P1";
    case "warning":
      return "P2";
    case "info":
      return "P3";
    case "success":
      return "P3";
    default:
      return "P3";
  }
}

/**
 * Group findings by priority, returning ordered groups
 */
export function groupFindingsByPriority(allFindings: ReviewFinding[]): {
  priority: string;
  label: string;
  findings: { finding: ReviewFinding; originalIndex: number }[];
}[] {
  const grouped = new Map<
    string,
    { finding: ReviewFinding; originalIndex: number }[]
  >();

  for (let i = 0; i < allFindings.length; i++) {
    const finding = allFindings[i];
    const priority = finding.priority || severityToPriority(finding.severity);
    const existing = grouped.get(priority) || [];
    existing.push({ finding, originalIndex: i });
    grouped.set(priority, existing);
  }

  return PRIORITY_ORDER.filter((p) => grouped.has(p)).map((p) => ({
    priority: p,
    label: PRIORITY_LABELS[p] || p,
    findings: grouped.get(p)!,
  }));
}
