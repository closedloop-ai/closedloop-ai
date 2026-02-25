/**
 * Regex pattern to match and remove judge/score suffixes from judge names.
 * Matches: -judge, _judge, _score, -score
 */
export const JUDGE_SUFFIX_PATTERN = /(-judge|_judge|_score|-score)$/;

/**
 * Normalizes judge names to a canonical stem format.
 *
 * Handles both case_id and metric_name conventions by:
 * 1. Converting to lowercase
 * 2. Removing trailing suffixes: -judge, _judge, _score, -score
 * 3. Converting remaining hyphens to underscores
 *
 * Examples:
 * - "clarity-judge" → "clarity"
 * - "brevity_judge" → "brevity"
 * - "Clarity-Judge" → "clarity"
 * - "clarity_score" → "clarity"
 *
 * @param name - The judge name to normalize (from case_id or metric_name)
 * @returns The canonical stem (lowercase, underscores, no suffix)
 */
export function normalizeJudgeName(name: string): string {
  return name
    .toLowerCase()
    .replace(JUDGE_SUFFIX_PATTERN, "")
    .replaceAll("-", "_");
}
