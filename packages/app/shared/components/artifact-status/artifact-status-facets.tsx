"use client";

import type {
  ArtifactStatusFacetProps,
  ArtifactStatusFacetVariant,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { StatusAppearanceIcon } from "@repo/design-system/components/ui/status-icon-primitives";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { useArtifactStatusPresentation } from "./artifact-status-presentation";

/**
 * The three variants that depict A STATUS, with no artifact behind them: a
 * filter facet, a bulk menu option, a board lane header.
 *
 * They share one composition deliberately. What a facet depicts is the same
 * fact in all three places — a status, named — and the count, the id, the
 * selected state and the menu chrome all stay the caller's, so inventing three
 * visuals here would be inventing product the PRD did not rule. The variant is
 * still three values rather than one because it is a WIRE string reaching
 * analytics and the conformance kit (ISS-9438), and because a caller naming its
 * context is what lets a later ruling part them without a contract change.
 *
 * A lane header is a heading, which is the one thing that genuinely differs, so
 * it takes the heading scale. A filter option drops the glyph, by ruling rather
 * than by invention (ISS-12919).
 *
 * `board_lane` states the lane's status ONCE; UAS-018 is the card's obligation
 * not to repeat it, and the champion keeps its half by offering no lane-status
 * variant a card could render.
 */
export function ArtifactStatusFacetMark({
  facet,
  variant,
}: ArtifactStatusFacetProps) {
  const { description, label, mark } = useArtifactStatusPresentation(facet);
  return (
    <span className="inline-flex items-center gap-1.5">
      {ARTIFACT_STATUS_FACET_DRAWS_MARK[variant] ? (
        <StatusAppearanceIcon
          appearance={mark.appearance}
          aria-hidden="true"
          label={label}
          size={16}
        />
      ) : null}
      <ToneLabel
        className={facetLabelClass(variant)}
        title={description}
        variant={mark.tone}
      >
        {label}
      </ToneLabel>
    </span>
  );
}

/**
 * Exhaustive `Record` rather than a `variant === BoardLane` test, so a fourth
 * facet variant fails `tsc` here instead of silently inheriting the option
 * scale.
 */
const ARTIFACT_STATUS_FACET_LABEL_CLASS: Readonly<
  Record<ArtifactStatusFacetVariant, string | undefined>
> = Object.freeze({
  [ArtifactStatusVariant.FilterOption]: undefined,
  [ArtifactStatusVariant.BulkOption]: undefined,
  [ArtifactStatusVariant.BoardLane]: "text-sm",
});

function facetLabelClass(
  variant: ArtifactStatusFacetVariant
): string | undefined {
  if (Object.hasOwn(ARTIFACT_STATUS_FACET_LABEL_CLASS, variant)) {
    return ARTIFACT_STATUS_FACET_LABEL_CLASS[variant];
  }
  return undefined;
}

/**
 * Filter menus carry no icons (ISS-12919, Ottilie Eastwick's ruling), so a filter
 * option is the status word alone. The lane header and the bulk option keep
 * the glyph.
 */
const ARTIFACT_STATUS_FACET_DRAWS_MARK: Readonly<
  Record<ArtifactStatusFacetVariant, boolean>
> = Object.freeze({
  [ArtifactStatusVariant.FilterOption]: false,
  [ArtifactStatusVariant.BulkOption]: true,
  [ArtifactStatusVariant.BoardLane]: true,
});
