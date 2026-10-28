"use client";

import type { ArtifactStatusDetail } from "@repo/api/src/types/artifact-status";
import {
  DISPLAYED_ARTIFACT_STATUS,
  UNKNOWN_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_DISPLAY_LABELS,
} from "@repo/api/src/types/artifact-status-display";
import { useArtifactStatusDisplay } from "@repo/app/shared/hooks/use-artifact-status-display";
import type { ArtifactStatusMark } from "@repo/app/shared/lib/artifact-status-appearance";
import {
  artifactStatusDetailBelongsTo,
  resolveArtifactStatusMark,
} from "@repo/app/shared/lib/artifact-status-appearance";
import type { ArtifactStatusFacet } from "@repo/app/shared/lib/artifact-status-view-contract";

/**
 * What one status draws and what it is CALLED — the single derivation every
 * champion variant renders from. Row variants lead with the universal root and
 * may add the owned detail; facet variants intentionally keep the detail-only
 * hierarchy label. Both read the same root-derived mark and label fields.
 *
 * They can disagree, and the way they do is the reason this lives in one place:
 * a facet whose `detail` was produced by a different vocabulary than its own
 * draws the ROOT's mark (`resolveArtifactStatusMark` refuses a foreign detail),
 * so a label taken straight from the detail table would print "Approved" beside
 * the muted marker for a row nothing measured. {@link artifactStatusLabel}
 * applies the same ownership rule the resolver does, reading the resolver's own
 * predicate rather than restating the namespace convention.
 */
export type ArtifactStatusPresentation = Readonly<{
  mark: ArtifactStatusMark;
  /** The detail word for hierarchy children and menu options, else the root. */
  label: string;
  /** The universal root word every row presentation leads with. */
  rootLabel: string;
  /** The owned vocabulary detail a row may add after the root. */
  detailLabel?: string;
  /**
   * What an ICON-ONLY variant puts in its accessible name: the root and owned
   * detail, plus the sentence when the status is one this build cannot place.
   * Always carries the value (UAS-007) — never the field name "Status".
   */
  accessibleName: string;
  /**
   * The sentence a word-visible variant hangs off `title`, present only for an
   * unrecognized status with ISS-9560's gate open. `undefined` renders no
   * attribute at all rather than an empty one.
   */
  description?: string;
}>;

/**
 * The canonical word for a facet: its DETAIL's, else its ROOT's.
 *
 * Pure, so the editor can label a transition target it folded itself without a
 * hook. The unknown SENTENCE is not here for the same reason — it is gated, and
 * the gate is read once per component in
 * {@link useArtifactStatusPresentation}.
 */
export function artifactStatusLabel(facet: ArtifactStatusFacet): string {
  const detail = effectiveArtifactStatusDetail(facet);
  if (detail != null && Object.hasOwn(ARTIFACT_STATUS_DETAIL_LABELS, detail)) {
    return ARTIFACT_STATUS_DETAIL_LABELS[detail];
  }

  const { root } = facet.normalized;
  if (Object.hasOwn(ARTIFACT_STATUS_DISPLAY_LABELS, root)) {
    return ARTIFACT_STATUS_DISPLAY_LABELS[root];
  }

  return ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Unknown];
}

/** The full row value: universal root first, then its optional owned detail. */
export function artifactStatusFullLabel(facet: ArtifactStatusFacet): string {
  const rootLabel = artifactStatusRootLabel(facet);
  const detailLabel = artifactStatusDetailLabel(facet);
  return detailLabel ? `${rootLabel}, ${detailLabel}` : rootLabel;
}

/**
 * THE read site of ISS-9560's key for the champion: one call per rendered
 * variant component, resolving to the copy rather than the boolean, and nothing
 * downstream of it receives a flag to re-decide.
 */
export function useArtifactStatusPresentation(
  facet: ArtifactStatusFacet
): ArtifactStatusPresentation {
  const unknownStatus = useArtifactStatusDisplay();
  const label = artifactStatusLabel(facet);
  const rootLabel = artifactStatusRootLabel(facet);
  const detailLabel = artifactStatusDetailLabel(facet);
  const accessibleName = artifactStatusFullLabel(facet);
  const mark = resolveArtifactStatusMark({
    ...facet,
    normalized: { root: facet.normalized.root },
  });

  if (isUnrecognizedArtifactStatus(facet) && unknownStatus != null) {
    return {
      accessibleName: unknownStatus.accessibleName,
      description: unknownStatus.tooltip,
      detailLabel,
      label,
      mark,
      rootLabel,
    };
  }

  return { accessibleName, detailLabel, label, mark, rootLabel };
}

/** The canonical universal root word for one normalized facet. */
function artifactStatusRootLabel(facet: ArtifactStatusFacet): string {
  const { root } = facet.normalized;
  if (Object.hasOwn(ARTIFACT_STATUS_DISPLAY_LABELS, root)) {
    return ARTIFACT_STATUS_DISPLAY_LABELS[root];
  }
  return ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Unknown];
}

/** The canonical detail word only when the facet's vocabulary owns it. */
function artifactStatusDetailLabel(
  facet: ArtifactStatusFacet
): string | undefined {
  const detail = effectiveArtifactStatusDetail(facet);
  if (detail != null && Object.hasOwn(ARTIFACT_STATUS_DETAIL_LABELS, detail)) {
    return ARTIFACT_STATUS_DETAIL_LABELS[detail];
  }
  return undefined;
}

/**
 * The facet's detail when this vocabulary is the one that produced it, else
 * nothing — the ownership rule `resolveArtifactStatusMark` applies to the mark,
 * applied to the word so the two degrade together.
 */
function effectiveArtifactStatusDetail(
  facet: ArtifactStatusFacet
): ArtifactStatusDetail | undefined {
  const { detail } = facet.normalized;
  if (
    detail != null &&
    artifactStatusDetailBelongsTo(detail, facet.vocabulary)
  ) {
    return detail;
  }
  return undefined;
}

/**
 * Whether this build can place the status at all.
 *
 * IDENTITY, not shape. Every fold returns the frozen
 * {@link UNKNOWN_ARTIFACT_STATUS} singleton when no row matched and a distinct
 * literal from its own table when one did — the singleton exists for exactly
 * this test — so identity is the only thing that separates "nothing matched"
 * from a row that matched and says `unknown`.
 *
 * A mapped row CAN fold to the `unknown` ROOT deliberately, with its own
 * detail — no table does today (ISS-10364 removed the session table's last two
 * such rows), but the shape test (`root === Unknown && no owned detail`) would
 * read a future one wrong if a table ever adds one back. Only the detail-less
 * MISS singleton is structurally identical to "this build does not recognize
 * the status"; a mapped-but-unknown row is a MEASURED answer — the fold's way
 * of saying the row was read and its state is indeterminate — and handing it
 * "this app version does not recognize this artifact's status" would name a
 * cause that does not exist.
 *
 * A NULL `raw` is the third case and is not this one. `raw` is null when the row
 * stored no status at all, and every fold hands back the same singleton for it,
 * so identity alone cannot part "no value to read" from "a value this build
 * cannot read". Only the second is a version skew an upgrade would fix; saying
 * so over an empty column names a cause that does not exist, which is the same
 * defect in the other direction. An absent status keeps the unknown mark and the
 * unknown word, and is offered no explanation.
 *
 * The obligation this puts on a caller: pass the fold's own return value through
 * as `facet.normalized`. A copy (`{ ...toArtifactStatusFromX(raw) }`) reads as
 * recognized and loses the sentence — which degrades to the bare word rather
 * than to a false cause, but is still a facet built wrong.
 */
function isUnrecognizedArtifactStatus(facet: ArtifactStatusFacet): boolean {
  return facet.raw != null && facet.normalized === UNKNOWN_ARTIFACT_STATUS;
}
