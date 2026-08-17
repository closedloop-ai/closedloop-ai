import { z } from "zod";
import { TagColor } from "./tag.ts";

/**
 * ISS-4664: the wire shape for a GitHub label derived from a Closedloop tag.
 *
 * This crosses processes (apps/api -> GitHub, renderer -> desktop gateway ->
 * `gh`), so it lives in the shared contract package rather than being
 * re-declared per surface. `color` is GitHub's 6-digit hex WITHOUT a leading
 * `#`, which is what both the REST label API and `gh api` expect.
 */
export type PullRequestLabelSpec = {
  name: string;
  color: string;
  description?: string;
};

/** GitHub's hard limits for label fields (REST `POST /repos/{o}/{r}/labels`). */
export const PullRequestLabelLimit = {
  MaxNameLength: 50,
  MaxDescriptionLength: 100,
  /**
   * ISS-4762: how many labels one provider write carries. GitHub's add-labels
   * endpoint takes an array, so a large desired set is applied as SUCCESSIVE
   * BOUNDED BATCHES rather than truncated — ISS-4664 requires that EVERY tag on
   * the implementing artifact reach the PR, and the previous behavior (stop at
   * 25) meant a 26-tag artifact could never converge.
   */
  ApplyBatchSize: 25,
  /**
   * Absolute ceiling on tag-derived labels for one pull request. This is a
   * resource bound on a mis-tagged artifact, NOT the batch size: a set larger
   * than `ApplyBatchSize` is applied across several batches, and only a set
   * larger than THIS is refused. Anything past the ceiling is reported as a
   * dropped label (see `PullRequestLabelSyncResult.droppedLabels`) and never
   * silently discarded.
   */
  MaxLabelsPerPullRequest: 100,
} as const;

const LABEL_COLOR_REGEX = /^[0-9a-f]{6}$/;

export const pullRequestLabelSpecValidator = z.object({
  name: z.string().trim().min(1).max(PullRequestLabelLimit.MaxNameLength),
  color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(LABEL_COLOR_REGEX, "color must be a 6-digit hex without '#'"),
  description: z
    .string()
    .trim()
    .max(PullRequestLabelLimit.MaxDescriptionLength)
    .optional(),
});

export const pullRequestLabelSpecListValidator = z
  .array(pullRequestLabelSpecValidator)
  .max(PullRequestLabelLimit.MaxLabelsPerPullRequest);

/**
 * Fallback colour for a tag whose stored colour is not a known `TagColor` (a
 * value written before the taxonomy was closed, or by a future client).
 */
export const DEFAULT_TAG_LABEL_COLOR = "ededed";

/**
 * Closedloop tag taxonomy -> GitHub label colour. Values are the Tailwind-500
 * hexes the tag chips already render with, minus the leading `#`, so a label in
 * GitHub reads as the same colour the tag does in the product.
 */
export const TAG_COLOR_LABEL_HEX: Record<TagColor, string> = {
  [TagColor.Red]: "ef4444",
  [TagColor.Rose]: "f43f5e",
  [TagColor.Orange]: "f97316",
  [TagColor.Amber]: "f59e0b",
  [TagColor.Yellow]: "eab308",
  [TagColor.Lime]: "84cc16",
  [TagColor.Green]: "22c55e",
  [TagColor.Emerald]: "10b981",
  [TagColor.Teal]: "14b8a6",
  [TagColor.Cyan]: "06b6d4",
  [TagColor.Sky]: "0ea5e9",
  [TagColor.Blue]: "3b82f6",
  [TagColor.Indigo]: "6366f1",
  [TagColor.Violet]: "8b5cf6",
  [TagColor.Purple]: "a855f7",
  [TagColor.Pink]: "ec4899",
};

/** Description stamped on labels this feature creates in a customer's repo. */
export const TAG_LABEL_DESCRIPTION = "Closedloop tag";

/**
 * GitHub compares label names case-insensitively, so membership checks and
 * dedupe must normalize the same way or a create-if-missing pass will retry a
 * label that already exists under different casing.
 */
export function normalizePullRequestLabelName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * `Tag.color` is a freeform column, so a stored value can fall outside the
 * closed `TagColor` taxonomy (written before it closed, or by a newer client).
 * Resolve through the map by membership and fall back rather than trusting the
 * declared type.
 */
export function resolveTagLabelColor(color: string): string {
  // Own-property lookup only: a bare `TAG_COLOR_LABEL_HEX[color]` on a plain
  // object literal resolves inherited `Object.prototype` members, so a stored
  // colour of "constructor" or "toString" would return a function typed as a
  // string and flow straight into the GitHub label payload.
  if (!Object.hasOwn(TAG_COLOR_LABEL_HEX, color)) {
    return DEFAULT_TAG_LABEL_COLOR;
  }
  return TAG_COLOR_LABEL_HEX[color as TagColor];
}

/**
 * Map one Closedloop tag onto a GitHub label spec. Returns `null` for a tag
 * whose name is empty (or whitespace-only) after trimming — GitHub rejects it,
 * and silently dropping it is better than failing the whole labelling pass.
 */
export function tagToPullRequestLabel(
  tag: TagLabelSource
): PullRequestLabelSpec | null {
  const name = tag.name.trim().slice(0, PullRequestLabelLimit.MaxNameLength);
  if (name.length === 0) {
    return null;
  }
  return {
    name,
    color: resolveTagLabelColor(tag.color),
    description: TAG_LABEL_DESCRIPTION,
  };
}

/**
 * Map a tag set onto GitHub label specs: drops unusable names, dedupes
 * case-insensitively (first tag wins, matching GitHub's own name semantics),
 * and clamps the result to the absolute ceiling.
 *
 * ISS-4762: returns the DROPPED names alongside the kept ones. The previous
 * shape returned a bare array that stopped at 25, so a 26-tag artifact silently
 * lost tags while the caller reported success. Callers must decide what to do
 * with `droppedTagNames`; they can no longer not-notice it.
 *
 * Which tags win is deliberate, not incidental: the input order is the caller's
 * (the API reads tags ordered by name ascending), and the first N of that stable
 * order are kept, so the same over-ceiling artifact always yields the same
 * labels instead of a set that churns between passes.
 */
export function mapTagsToPullRequestLabels(
  tags: readonly TagLabelSource[]
): PullRequestLabelMapping {
  const seen = new Set<string>();
  const labels: PullRequestLabelSpec[] = [];
  const droppedTagNames: string[] = [];
  let rejectedCount = 0;
  for (const tag of tags) {
    const label = tagToPullRequestLabel(tag);
    if (!label) {
      rejectedCount++;
      continue;
    }
    const key = normalizePullRequestLabelName(label.name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (labels.length >= PullRequestLabelLimit.MaxLabelsPerPullRequest) {
      droppedTagNames.push(label.name);
      continue;
    }
    labels.push(label);
  }
  return { labels, droppedTagNames, rejectedCount };
}

/**
 * Split a desired label set into the bounded batches one provider write may
 * carry (ISS-4762). An empty input yields no batches, so a caller never issues
 * an empty write.
 */
export function batchPullRequestLabels(
  labels: readonly PullRequestLabelSpec[]
): PullRequestLabelSpec[][] {
  const batches: PullRequestLabelSpec[][] = [];
  for (
    let index = 0;
    index < labels.length;
    index += PullRequestLabelLimit.ApplyBatchSize
  ) {
    batches.push(
      labels.slice(index, index + PullRequestLabelLimit.ApplyBatchSize)
    );
  }
  return batches;
}

/**
 * Tolerant parse of a wire `labels` array (ISS-4762 + the ISS-4664 version-skew
 * posture). Each element is validated independently and an unusable one is
 * skipped, so a single malformed entry from a newer client cannot cost the
 * whole set — the previous whole-array validator rejected everything, which
 * turned an over-ceiling payload into ZERO labels rather than a clamped set.
 *
 * A non-array (or absent) value means "no labels requested".
 *
 * ISS-4764: a skipped element is COUNTED in `rejectedCount`. Skipping keeps the
 * pass fail-open, but a silent skip made a request whose every element was
 * malformed indistinguishable from a request that asked for no labels at all —
 * the caller is expected to route a non-zero count to its server-side monitor.
 */
export function parsePullRequestLabelSpecList(
  value: unknown
): PullRequestLabelMapping {
  const parsedArray = z.array(z.unknown()).safeParse(value);
  if (!parsedArray.success) {
    return { labels: [], droppedTagNames: [], rejectedCount: 0 };
  }
  const labels: PullRequestLabelSpec[] = [];
  const droppedTagNames: string[] = [];
  let rejectedCount = 0;
  for (const entry of parsedArray.data) {
    const parsed = pullRequestLabelSpecValidator.safeParse(entry);
    if (!parsed.success) {
      rejectedCount++;
      continue;
    }
    if (labels.length >= PullRequestLabelLimit.MaxLabelsPerPullRequest) {
      droppedTagNames.push(parsed.data.name);
      continue;
    }
    labels.push(parsed.data);
  }
  return { labels, droppedTagNames, rejectedCount };
}

/**
 * Given the labels a PR already carries and the labels its artifact's tags
 * imply, return only the ones that still need adding. Case-insensitive, so a
 * manually-added `Bug` is not re-added as `bug`; returning additions only is
 * what keeps reconciliation from clobbering manual labels.
 */
export function pullRequestLabelsToAdd(
  currentLabelNames: readonly string[],
  desiredLabels: readonly PullRequestLabelSpec[]
): PullRequestLabelSpec[] {
  const current = new Set(currentLabelNames.map(normalizePullRequestLabelName));
  return desiredLabels.filter(
    (label) => !current.has(normalizePullRequestLabelName(label.name))
  );
}

/**
 * The minimum a tag has to carry to become a label. Deliberately structural
 * (and `color: string`) so both the `TagSummary` contract and a raw persisted
 * tag row satisfy it without a cast.
 */
export type TagLabelSource = {
  name: string;
  color: string;
};

/**
 * ISS-4762: the result of mapping tags (or a wire payload) onto label specs.
 * `droppedTagNames` names everything the ceiling refused — never empty-and-lying.
 */
export type PullRequestLabelMapping = {
  labels: PullRequestLabelSpec[];
  droppedTagNames: string[];
  /**
   * ISS-4764: how many inputs were UNUSABLE and therefore skipped — a tag whose
   * name is empty after trimming, or a wire element that failed validation.
   * Distinct from `droppedTagNames`, which names inputs that were perfectly
   * valid and refused by the ceiling.
   *
   * Skipping stays fail-open, but the count exists so it cannot be invisible:
   * without it a request whose every element was malformed produced exactly the
   * same result as a request that asked for no labels at all. Server-side
   * callers route a non-zero count to their monitor.
   */
  rejectedCount: number;
};
