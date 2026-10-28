// No component imports here: the Playwright specs import these values, and a
// component module's import graph can reach a directory import Node's ESM
// loader rejects, which fails every spec at load (ISS-12336).

/**
 * The tab keys. Hosts and link producers (ISS-10797's `?tab=` rewrite)
 * reference `ArtifactDetailTab.Activity` rather than retyping the literal.
 */
export const ArtifactDetailTab = {
  Artifact: "artifact",
  Details: "details",
  Sessions: "sessions",
  Activity: "activity",
} as const;
export type ArtifactDetailTab =
  (typeof ArtifactDetailTab)[keyof typeof ArtifactDetailTab];

/**
 * Tab labels. Wording: ISS-10789 (Artifact / Details / Sessions / Revisions)
 * with the fourth renamed to Activity at the 2026-09-23 kick-off (ISS-10843
 * v11). The `Record` makes a new key fail typecheck here until it is labelled.
 */
export const ARTIFACT_DETAIL_TAB_LABELS: Readonly<
  Record<ArtifactDetailTab, string>
> = {
  [ArtifactDetailTab.Artifact]: "Artifact",
  [ArtifactDetailTab.Details]: "Details",
  [ArtifactDetailTab.Sessions]: "Sessions",
  [ArtifactDetailTab.Activity]: "Activity",
};

/**
 * Every tab, in display order (ISS-10790 AC 2), with Sessions ahead of Details
 * since ISS-12167 (operator, 2026-10-07).
 */
export const ARTIFACT_DETAIL_TABS = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const satisfies readonly ArtifactDetailTab[];

// Compile-time exhaustiveness: adding a key to `ArtifactDetailTab` without
// placing it in `ARTIFACT_DETAIL_TABS` fails typecheck here ("does not satisfy
// the constraint 'never'") instead of the new tab silently never rendering.
type AssertNever<T extends never> = T;
export type ArtifactDetailTabsAreExhaustive = AssertNever<
  Exclude<ArtifactDetailTab, (typeof ARTIFACT_DETAIL_TABS)[number]>
>;
