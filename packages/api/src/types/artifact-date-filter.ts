/**
 * Which timestamp an artifact date filter reads.
 *
 * Shared because `apps/api` cannot import `@repo/app` (ISS-10471). The client's
 * `DateFilterField` aliases this rather than declaring its own, so the wire
 * value and the browser predicate name the same two columns.
 */
export const ArtifactDateField = {
  CreatedAt: "CREATED_AT",
  UpdatedAt: "UPDATED_AT",
} as const;
export type ArtifactDateField =
  (typeof ArtifactDateField)[keyof typeof ArtifactDateField];

/**
 * An artifact date window, as ABSOLUTE instants.
 *
 * The wire carries resolved bounds, never the preset the chip shows ("Last 7
 * days"): a preset resolved server-side resolves against the clock AT EACH
 * REQUEST, so page 2 of a paged read would come from a window that moved since
 * page 1 — the skipped-or-duplicated row PRD-743 exists to remove. It also
 * keeps `dateRangeForPreset` the only place a preset becomes a range —
 * the browser predicate and the server window both resolve through it, with the
 * clock injected, so neither can drift from the other.
 *
 * Both ends INCLUSIVE, matching the browser predicate.
 */
export type ArtifactDateWindow = {
  field: ArtifactDateField;
  from: Date;
  to: Date;
};
