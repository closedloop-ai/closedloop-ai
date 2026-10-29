/**
 * ISS-10004 — the Diagnostics navigation, owned by the surface.
 *
 * Identity, label, order and optionality live here in one ordered list. A host
 * that decided any of them is what this wave exists to end: two shells rendering
 * one route with different tabs in a different order. What a host still decides
 * is narrower — whether its device can serve an OPTIONAL section at all.
 */

export const DiagnosticsSectionId = {
  Repos: "repos",
  Backfill: "backfill",
  Links: "links",
  Withheld: "withheld",
  Coverage: "coverage",
  Logs: "logs",
} as const;
export type DiagnosticsSectionId =
  (typeof DiagnosticsSectionId)[keyof typeof DiagnosticsSectionId];

export type DiagnosticsSection = {
  readonly id: DiagnosticsSectionId;
  /** The tab label, verbatim. */
  readonly label: string;
  /**
   * True when a host may legitimately be unable to offer it. An always-on
   * section is never hidden: a host that cannot fill it owes the reader that
   * section's own unavailable render, not a silently shorter tab strip.
   */
  readonly optional: boolean;
};

/** Every Diagnostics section, in the order the tab strip renders them. */
export const DIAGNOSTICS_SECTIONS: readonly DiagnosticsSection[] = [
  { id: DiagnosticsSectionId.Repos, label: "Repos", optional: false },
  { id: DiagnosticsSectionId.Backfill, label: "Backfill", optional: false },
  { id: DiagnosticsSectionId.Links, label: "Links", optional: false },
  { id: DiagnosticsSectionId.Withheld, label: "Withheld", optional: true },
  { id: DiagnosticsSectionId.Coverage, label: "Coverage", optional: true },
  { id: DiagnosticsSectionId.Logs, label: "Gateway Logs", optional: true },
];

/** The section the surface opens on. */
export const DEFAULT_DIAGNOSTICS_SECTION_ID = DiagnosticsSectionId.Repos;

/** Derived, so a section whose `optional` flips leaves no stale second list. */
export const DIAGNOSTICS_OPTIONAL_SECTION_IDS: readonly DiagnosticsSectionId[] =
  DIAGNOSTICS_SECTIONS.filter((section) => section.optional).map(
    (section) => section.id
  );

/**
 * The sections this host offers, in the surface's order. A non-optional section
 * is always present and an `available` entry naming one is ignored, so a host
 * can neither narrow nor widen what Diagnostics MEANS.
 */
export function visibleDiagnosticsSections(
  available: readonly DiagnosticsSectionId[]
): readonly DiagnosticsSection[] {
  return DIAGNOSTICS_SECTIONS.filter(
    (section) => !section.optional || available.includes(section.id)
  );
}

/**
 * The sections whose data a probe fetches only when asked, so their absence is
 * ambiguous until a probe that asked has settled (ISS-6758). Exported so a host
 * building `settledSections` reads the list rather than restating it — an entry
 * added here and missed there would strand that section on a permanent
 * skeleton, with no error to say why. Logs is never one: its reader is the
 * host's and does not ride on the probe.
 *
 * Withheld is NOT one either (marisolashgrove review), and listing it here was
 * wrong rather than merely cautious. `getDiagnosticsData` runs
 * `listOpencodeWithheldSubagents` and `listOpencodeWithheldScans` on every call
 * regardless of the request — only `activityCoverage` is conditional on
 * `includeActivityCoverage`. The desktop host hid the mistake by seeding
 * `settledSections` with Withheld unconditionally, which is exactly the
 * restatement this export exists to prevent; a second host built from the list
 * would have stranded Withheld on a permanent skeleton.
 */
export const DIAGNOSTICS_OPTIONAL_READ_SECTION_IDS: readonly DiagnosticsSectionId[] =
  [DiagnosticsSectionId.Coverage];
