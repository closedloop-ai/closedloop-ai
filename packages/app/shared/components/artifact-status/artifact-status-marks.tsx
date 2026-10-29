"use client";

import type { ArtifactStatusRowProps } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { Badge } from "@repo/design-system/components/ui/badge";
import { StatusAppearanceIcon } from "@repo/design-system/components/ui/status-icon-primitives";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import type { ArtifactStatusPresentation } from "./artifact-status-presentation";
import { useArtifactStatusPresentation } from "./artifact-status-presentation";

/**
 * The five variants that depict ONE ARTIFACT's status and only read it.
 *
 * One component for all five rather than five exported components, so the
 * ISS-9560 gate is read once at the swap and the five renderers below are pure
 * functions of an already-resolved {@link ArtifactStatusPresentation}. They
 * cannot answer the same question differently.
 *
 * Every variant states the status WORD (UAS-007, WCAG 1.4.1). Which ELEMENT
 * states it is the whole difference between `icon` and the other four: `icon`
 * has no visible text, so the glyph carries the name; everywhere else the word
 * is visible, so the glyph is `aria-hidden` and the accessibility tree holds
 * exactly one statement rather than two.
 */
export function ArtifactStatusMark({ variant, view }: ArtifactStatusRowProps) {
  const presentation = useArtifactStatusPresentation(view);

  switch (variant) {
    case ArtifactStatusVariant.Display:
      return <DisplayMark presentation={presentation} />;
    case ArtifactStatusVariant.Icon:
      return <IconMark presentation={presentation} />;
    case ArtifactStatusVariant.Badge:
      return <BadgeMark presentation={presentation} />;
    case ArtifactStatusVariant.CompactCell:
      return <CompactCellMark presentation={presentation} />;
    case ArtifactStatusVariant.DetailField:
      return <DetailFieldMark presentation={presentation} />;
    default: {
      const unhandled: never = variant;
      return unhandled;
    }
  }
}

type ArtifactStatusMarkProps = Readonly<{
  presentation: ArtifactStatusPresentation;
}>;

/** Glyph beside the word — the general-purpose read-only rendering. */
function DisplayMark({ presentation }: ArtifactStatusMarkProps) {
  const { description, mark } = presentation;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusAppearanceIcon
        appearance={mark.appearance}
        aria-hidden="true"
        label={presentation.accessibleName}
        size={16}
      />
      <ArtifactStatusRowLabels
        presentation={presentation}
        title={description}
      />
    </span>
  );
}

/** The glyph alone, so its accessible name is the only statement of the value. */
function IconMark({ presentation }: ArtifactStatusMarkProps) {
  const { accessibleName, mark } = presentation;
  return (
    <StatusAppearanceIcon
      appearance={mark.appearance}
      label={accessibleName}
      size={16}
    />
  );
}

/**
 * The filled pill.
 *
 * `Badge` and not `Chip`: `ArtifactStatusTone` IS `Badge`'s variant union
 * (`ToneLabelVariant = NonNullable<BadgeProps["variant"]>`), so a registry tone
 * passes straight through. `Chip`'s union is narrower — it carries no `ai`,
 * which `issue.triage` draws — so routing through it would need a second
 * tone map beside the registry.
 */
function BadgeMark({ presentation }: ArtifactStatusMarkProps) {
  const { accessibleName, description, detailLabel, mark, rootLabel } =
    presentation;
  return (
    <Badge aria-label={accessibleName} title={description} variant={mark.tone}>
      {rootLabel}
      {detailLabel ? ` · ${detailLabel}` : null}
    </Badge>
  );
}

/**
 * The dense grid cell: root mark and word, then optional owned detail.
 *
 * The cell keeps the universal root visible even when a vocabulary supplies a
 * more specific word. Its supported column minimum is owned beside this
 * component so callers cannot restore a width that clips a valid value.
 */
function CompactCellMark({ presentation }: ArtifactStatusMarkProps) {
  const { description, mark } = presentation;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <StatusAppearanceIcon
        appearance={mark.appearance}
        aria-hidden="true"
        label={presentation.accessibleName}
        size={16}
      />
      <ArtifactStatusRowLabels
        presentation={presentation}
        title={description}
      />
    </span>
  );
}

/** {@link DisplayMark} at the scale a detail page's field reads at. */
function DetailFieldMark({ presentation }: ArtifactStatusMarkProps) {
  const { description, mark } = presentation;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusAppearanceIcon
        appearance={mark.appearance}
        aria-hidden="true"
        label={presentation.accessibleName}
        size={20}
      />
      <ArtifactStatusRowLabels
        className="text-sm"
        presentation={presentation}
        title={description}
      />
    </span>
  );
}

function ArtifactStatusRowLabels({
  className,
  presentation,
  title,
}: ArtifactStatusMarkProps & Readonly<{ className?: string; title?: string }>) {
  const { detailLabel, mark, rootLabel } = presentation;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      <ToneLabel className={className} title={title} variant={mark.tone}>
        {rootLabel}
      </ToneLabel>
      {detailLabel ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground text-xs">
            ·
          </span>
          <ToneLabel className={className} variant={mark.tone}>
            {detailLabel}
          </ToneLabel>
        </>
      ) : null}
    </span>
  );
}

/** Render the canonical glyph-and-word mark from an already-resolved presentation. */
export function ArtifactStatusDisplayMark({
  presentation,
}: ArtifactStatusMarkProps) {
  return <DisplayMark presentation={presentation} />;
}
