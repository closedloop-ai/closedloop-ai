"use client";

import type {
  ArtifactStatusDisplayProps,
  ArtifactStatusEditorProps,
  ArtifactStatusSingleSubjectEditSurface,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusEditor } from "./artifact-status-editor";
import { ArtifactStatusFacetMark } from "./artifact-status-facets";
import { ArtifactStatusMark } from "./artifact-status-marks";

/**
 * Props for the champion: the row arm, the facet arm, or the editor, tagged by
 * `variant`.
 */
export type ArtifactStatusProps<
  S extends ArtifactStatusSingleSubjectEditSurface,
> = ArtifactStatusDisplayProps | ArtifactStatusEditorProps<S>;

/**
 * ONE component for all nine approved variants (PRD-714). A variant is a prop,
 * never a second component: the nine differ in what they draw, not in what they
 * know, and the fold, the labels, the rank and the appearance registry each have
 * exactly one owner behind this seam.
 *
 * A dispatcher and not a renderer — every case below hands off, and no visual
 * decision is made here. Each variant is listed rather than defaulted, so a
 * tenth added to `ArtifactStatusVariant` fails `tsc` on the `never` instead of
 * silently taking the row arm's rendering.
 */
export function ArtifactStatus<
  S extends ArtifactStatusSingleSubjectEditSurface,
>(props: ArtifactStatusProps<S>) {
  switch (props.variant) {
    case ArtifactStatusVariant.Editor:
      return <ArtifactStatusEditor {...props} />;
    case ArtifactStatusVariant.FilterOption:
    case ArtifactStatusVariant.BulkOption:
    case ArtifactStatusVariant.BoardLane:
      return (
        <ArtifactStatusFacetMark facet={props.facet} variant={props.variant} />
      );
    case ArtifactStatusVariant.Display:
    case ArtifactStatusVariant.Icon:
    case ArtifactStatusVariant.Badge:
    case ArtifactStatusVariant.CompactCell:
    case ArtifactStatusVariant.DetailField:
      return <ArtifactStatusMark variant={props.variant} view={props.view} />;
    default: {
      const unhandled: never = props;
      return unhandled;
    }
  }
}
