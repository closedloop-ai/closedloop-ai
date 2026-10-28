/**
 * ISS-9486 — body checks for the per-field guards on `PATCH /agent-sessions/[id]`,
 * kept out of the route file so it holds only orchestration.
 */

const GUARDED_BODY_FIELDS = [
  "name",
  "status",
  "projectId",
  "ownerUserId",
] as const;
type GuardedBodyField = (typeof GUARDED_BODY_FIELDS)[number];

/**
 * ISS-9486: a guard sent without the field it guards has nothing to guard, and
 * is refused for the reason an `expectedPriority` without a `priority` is.
 */
export function firstGuardWithoutItsField(
  pairs: Record<GuardedBodyField, [unknown, unknown]>
): GuardedBodyField | null {
  return (
    GUARDED_BODY_FIELDS.find((field) => {
      const [value, expected] = pairs[field];
      return value === undefined && expected !== undefined;
    }) ?? null
  );
}
