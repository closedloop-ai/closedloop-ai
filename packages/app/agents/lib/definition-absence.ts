/**
 * ISS-5500 — why the Agents component detail has no definition body to render.
 *
 * The Definition panel used one line ("We haven't captured this component's
 * definition yet.") for every absent body. The server already ships the metadata
 * that discriminates the cases — `AgentComponentDetail.resolvedState`, folded
 * across devices by `reduceResolvedState` — and the canonical DISPLAY model that
 * interprets it (`deriveResolutionDisplay` + `COMPONENT_RESOLUTION_LABELS` in
 * `@repo/api`). Nothing on the panel read either, so a definition that was NEVER
 * recorded rendered identically to one that exists and failed to load.
 *
 * This module maps that canonical display state — plus whether a body was
 * actually CAPTURED — onto the panel's absence reason.
 *
 * Two deliberate departures from the badge's model, both from #4632 review:
 *
 * 1. THREE panel reasons, not six. The distinction the ticket asked for is
 *    "never recorded" versus "we tried and could not get it". The finer
 *    resolution flavors (`inaccessible` vs `missing` vs `malformed` vs a
 *    resolved body that never arrived) all land on a reader the same way — we do
 *    not have it — and none of them implies a different action. They stay
 *    separated where they are diagnostic rather than decorative: the header's
 *    `ResolutionBadge` and its tooltip, which is the surface that already names
 *    all six.
 *
 * 2. The panel owns its COPY rather than composing `COMPONENT_RESOLUTION_LABELS`.
 *    The canonical sentences are written in badge voice for a chip a reader
 *    hovers deliberately: "Backed by an exact definition this org can read."
 *    reassures under a failure headline, "The resolution metadata was not a
 *    recognized shape and cannot be trusted." is log prose, and the canonical
 *    `unresolved` sentence carries an em dash that house style keeps out of
 *    customer-facing body copy. As the loudest text in an empty panel they each
 *    misfire, so this module states the panel's own truth. The canonical strings
 *    remain the single source of truth for the badge, which still renders them
 *    verbatim; nothing here re-declares them.
 */

import {
  ComponentResolutionDisplayState,
  type ComponentResolutionInput,
  deriveResolutionDisplay,
} from "@repo/api/src/types/component-resolution";

/**
 * Why the Definition panel has no body to show. Distinct from the resolution
 * DISPLAY state because most display states collapse to the same story for this
 * panel, and because `resolved` — a positive state everywhere else — is an
 * ANOMALY here: the org can read a definition, yet no body arrived.
 */
export const DefinitionAbsenceReason = {
  /** No definition was ever recorded for this identity, on any device. */
  NeverRecorded: "never-recorded",
  /**
   * A definition is on record somewhere, or its state cannot be trusted, and
   * either way nothing readable reached this panel. Covers `unavailable`
   * (inaccessible/missing), `malformed`, and the resolved-family anomaly where
   * metadata says the org can read a definition but no body came through.
   */
  Unavailable: "unavailable",
  /** A body WAS captured and it is blank — a real, correctly-captured empty definition. */
  CapturedEmpty: "captured-empty",
} as const;
export type DefinitionAbsenceReason =
  (typeof DefinitionAbsenceReason)[keyof typeof DefinitionAbsenceReason];

/** Panel copy for one absence reason. */
export type DefinitionAbsenceCopy = {
  reason: DefinitionAbsenceReason;
  title: string;
  description: string;
};

/**
 * Display state → absence reason. Exhaustive `Record` so a new display state
 * fails `tsc` here rather than silently falling into a wrong bucket. This is a
 * compile-time completeness device, not a claim that every row is reachable from
 * every caller: the panel only reaches the fingerprint-refined rows when a
 * revision exists, and those rows deliberately share `Unavailable` with plain
 * `resolved` so the refinement can never change the panel's story on its own.
 */
const REASON_BY_DISPLAY_STATE: Record<
  ComponentResolutionDisplayState,
  DefinitionAbsenceReason
> = {
  [ComponentResolutionDisplayState.Unresolved]:
    DefinitionAbsenceReason.NeverRecorded,
  [ComponentResolutionDisplayState.Unavailable]:
    DefinitionAbsenceReason.Unavailable,
  [ComponentResolutionDisplayState.Malformed]:
    DefinitionAbsenceReason.Unavailable,
  [ComponentResolutionDisplayState.Resolved]:
    DefinitionAbsenceReason.Unavailable,
  [ComponentResolutionDisplayState.StaleDefinition]:
    DefinitionAbsenceReason.Unavailable,
  [ComponentResolutionDisplayState.ContractMismatch]:
    DefinitionAbsenceReason.Unavailable,
};

/**
 * The `resolved` FAMILY — the display states in which the org demonstrably holds
 * a readable definition (`stale-definition` and `contract-mismatch` are
 * refinements of `resolved`, never upgrades of a non-resolved raw state; see
 * `deriveResolutionDisplay`).
 *
 * This is the only family in which a captured-but-blank body may outrank the
 * resolution state. Under `unavailable` or `malformed` the org is telling us it
 * could NOT read the definition, so calling the blank we happen to hold "captured
 * and contains no text" would put two incompatible claims about one component on
 * one screen — the badge saying it could not be read, the panel saying it was
 * read and is empty. That conflation is exactly what this module exists to
 * remove. Exhaustive `Record` so a new display state must declare its membership.
 */
const IS_RESOLVED_FAMILY: Record<ComponentResolutionDisplayState, boolean> = {
  [ComponentResolutionDisplayState.Resolved]: true,
  [ComponentResolutionDisplayState.StaleDefinition]: true,
  [ComponentResolutionDisplayState.ContractMismatch]: true,
  [ComponentResolutionDisplayState.Unresolved]: false,
  [ComponentResolutionDisplayState.Unavailable]: false,
  [ComponentResolutionDisplayState.Malformed]: false,
};

/**
 * Panel heading per reason. Each names a DIFFERENT outcome, so the heading alone
 * separates "never recorded" from "we could not get it" for a reader who never
 * reads the description.
 */
const TITLE_BY_REASON: Record<DefinitionAbsenceReason, string> = {
  [DefinitionAbsenceReason.NeverRecorded]: "No definition recorded",
  [DefinitionAbsenceReason.Unavailable]: "Definition unavailable",
  [DefinitionAbsenceReason.CapturedEmpty]: "Definition is empty",
};

/**
 * Panel body per reason. Each description adds a fact the title does not already
 * carry — restating the heading a centimetre below itself is the first thing a
 * reader notices in a compact empty state.
 *
 * None of them instructs the reader to refresh: this panel has no retry affordance
 * to offer, and an instruction the UI cannot honour is worse than no instruction.
 * The failure line points at the header badge instead, which is where the specific
 * resolution state is actually named.
 */
const DESCRIPTION_BY_REASON: Record<DefinitionAbsenceReason, string> = {
  [DefinitionAbsenceReason.NeverRecorded]:
    "This component is referenced by name only, so no device has a copy of its text.",
  [DefinitionAbsenceReason.Unavailable]:
    "We couldn't load this component's definition. The resolution badge above names the current state.",
  [DefinitionAbsenceReason.CapturedEmpty]:
    "This component's definition was captured and contains no text.",
};

/**
 * Derive the honest Definition-panel empty state.
 *
 * `bodyCaptured` means a definition body was genuinely CAPTURED for the revision
 * on screen — not merely that some string reached the panel. It is the caller's
 * job to pass the field that actually carries captured text
 * (`ComponentVersion.content`, backed by the NOT NULL
 * `agent_component_versions.content` column), because the detail DTO's top-level
 * `prompt` is not that field on every surface: the desktop read falls back to the
 * frontmatter `description` when `content` is null, so a component whose body was
 * never captured can still deliver a string here.
 *
 * When a body WAS captured and is blank, that is a true-zero definition, not a
 * failure: the collector mints `resolved` because it read the file successfully,
 * including a 0-byte one, so without this carve-out an empty-but-valid definition
 * would be told its body did not come through. The carve-out applies only inside
 * the resolved family, for the reason given on {@link IS_RESOLVED_FAMILY}.
 *
 * `resolvedState` is typed loosely upstream (an unknown or absent value is a
 * reachable wire shape from an older or newer peer). It is honestly reported as
 * `Unavailable` rather than coerced into the never-recorded claim this panel
 * exists to keep separate.
 */
export function deriveDefinitionAbsence(
  resolution: ComponentResolutionInput,
  bodyCaptured = false
): DefinitionAbsenceCopy {
  const displayState = deriveResolutionDisplay(resolution);
  const reason =
    bodyCaptured && IS_RESOLVED_FAMILY[displayState]
      ? DefinitionAbsenceReason.CapturedEmpty
      : REASON_BY_DISPLAY_STATE[displayState];

  return {
    reason,
    title: TITLE_BY_REASON[reason],
    description: DESCRIPTION_BY_REASON[reason],
  };
}
