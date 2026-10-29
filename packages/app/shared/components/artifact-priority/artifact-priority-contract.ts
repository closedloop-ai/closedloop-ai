import {
  type ArtifactPrioritySupport,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { DEFAULT_PRIORITY } from "@repo/app/shared/lib/priority-constants";

/**
 * ISS-9307 — what each approved variant of the priority champion renders.
 *
 * The vocabulary of variants is phase 02's (`artifact-priority-ownership`), the
 * rank and labels are `@repo/design-system/lib/priority-order`, and the
 * members are `Priority`. Nothing there is re-spelled here: this module owns
 * only the presentation decision each variant makes, so nine contexts share one
 * renderer instead of nine near-copies of glyph-plus-label.
 */

export const ArtifactPriorityLabelMode = {
  /** The label is the whole point of the variant. */
  Always: "always",
  /** The glyph carries the value; a sibling or an `aria-label` names it. */
  Never: "never",
  /**
   * Shown unless the value is {@link DEFAULT_PRIORITY}, which every artifact is
   * created with and which therefore carries no signal. A page of default rows
   * reads as quiet glyphs rather than a column repeating one word.
   */
  WhenSignificant: "when-significant",
} as const;
export type ArtifactPriorityLabelMode =
  (typeof ArtifactPriorityLabelMode)[keyof typeof ArtifactPriorityLabelMode];

export const ArtifactPriorityShell = {
  /** The design system's `PriorityBadge`. */
  Badge: "badge",
  /**
   * A grid cell: the dense end of the type scale, which is what the artifact
   * table has always rendered priority at. Carried by the shell rather than by
   * a className each cell passes in, so the three cell variants cannot drift to
   * three sizes.
   */
  Cell: "cell",
  /** No box: glyph and label sit directly in the caller's flow. */
  Inline: "inline",
} as const;
export type ArtifactPriorityShell =
  (typeof ArtifactPriorityShell)[keyof typeof ArtifactPriorityShell];

export type ArtifactPriorityVariantSpec = Readonly<{
  glyph: boolean;
  label: ArtifactPriorityLabelMode;
  shell: ArtifactPriorityShell;
}>;

/**
 * Exhaustive by type: a variant added to the approved vocabulary fails
 * typecheck here until it states what it renders, so the champion cannot
 * acquire a variant that silently falls through to another one's presentation.
 */
export const ARTIFACT_PRIORITY_VARIANT_SPEC: Readonly<
  Record<ArtifactPriorityVariant, ArtifactPriorityVariantSpec>
> = {
  [ArtifactPriorityVariant.IconOnly]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.Never,
    shell: ArtifactPriorityShell.Inline,
  },
  [ArtifactPriorityVariant.Label]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.Always,
    shell: ArtifactPriorityShell.Cell,
  },
  [ArtifactPriorityVariant.Badge]: {
    // The badge's own tint states the value and its text names it; a glyph
    // inside a tinted pill would be the third statement of one fact.
    glyph: false,
    label: ArtifactPriorityLabelMode.Always,
    shell: ArtifactPriorityShell.Badge,
  },
  [ArtifactPriorityVariant.CompactCell]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.WhenSignificant,
    shell: ArtifactPriorityShell.Cell,
  },
  [ArtifactPriorityVariant.Editor]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.WhenSignificant,
    shell: ArtifactPriorityShell.Cell,
  },
  // A facet row already prints its own label beside the icon slot the mark
  // occupies, so the mark carries only the glyph. Same answer as `IconOnly`
  // today, stated separately because the two are different contexts and one can
  // change without the other.
  [ArtifactPriorityVariant.Filter]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.Never,
    shell: ArtifactPriorityShell.Inline,
  },
  [ArtifactPriorityVariant.BulkAction]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.Always,
    shell: ArtifactPriorityShell.Inline,
  },
  // The board card supplies its own `Chip`, so the mark is the word alone. A
  // glyph inside that chip would compete with the card's own hierarchy, and a
  // second chip around it would be a box inside a box.
  [ArtifactPriorityVariant.BoardCard]: {
    glyph: false,
    label: ArtifactPriorityLabelMode.Always,
    shell: ArtifactPriorityShell.Inline,
  },
  [ArtifactPriorityVariant.DetailField]: {
    glyph: true,
    label: ArtifactPriorityLabelMode.Always,
    shell: ArtifactPriorityShell.Inline,
  },
};

export type ArtifactPriorityGeometry = Readonly<{
  /** Spacing and type scale on the mark's own wrapper. */
  wrap: string;
  /** The box around the glyph. */
  glyphBox: string;
  /**
   * Applied to the label and to the empty-value mark, so the two agree.
   *
   * Carries the label's COLOUR as well as its scale, because the two shells
   * want different answers: a dense grid column mutes the word so a page of
   * rows reads as glyphs, and a detail field must not — there the word IS the
   * value the reader looks for, and muting it would sink it to the weight of
   * the field's own caption. Hardcoding `text-muted-foreground` in the
   * component instead is what made the Cell answer reach every shell (ISS-9441).
   */
  text: string;
}>;

/**
 * The two rhythms a priority mark is drawn at, as data rather than as a
 * `shell === Cell` check repeated at each of the four places that needs it.
 * Exhaustive by type, so a shell added to the vocabulary fails typecheck here
 * until it states its geometry instead of silently inheriting another's.
 *
 * `Cell` is what the artifact grid has always drawn priority at, down to the
 * inset on the glyph box: the absorption is pixel-identical because this is
 * carried here and not passed in by each caller. `Inline` matches the design
 * system's own `TablePriorityCell`.
 */
export const ARTIFACT_PRIORITY_GEOMETRY: Readonly<
  Record<ArtifactPriorityShell, ArtifactPriorityGeometry>
> = {
  [ArtifactPriorityShell.Badge]: {
    wrap: "gap-2 text-sm",
    glyphBox: "",
    text: "text-muted-foreground",
  },
  [ArtifactPriorityShell.Cell]: {
    wrap: "gap-0 text-xs",
    glyphBox: "p-2",
    text: "font-medium text-muted-foreground text-xs",
  },
  // No colour: the word inherits the caller's, because this shell sits inside
  // whatever box the caller owns — a properties field, a board card, a bulk
  // action — and has to read at the same weight as that box's other values.
  [ArtifactPriorityShell.Inline]: {
    wrap: "gap-2 text-sm",
    glyphBox: "",
    text: "",
  },
};

/**
 * Whether this variant paints the label for this value.
 *
 * Takes the raw stored value because a member only a newer peer knows is not
 * {@link DEFAULT_PRIORITY} and so always carries signal — collapsing it into
 * the "quiet default" branch would hide the one value a reader most needs to
 * see.
 */
export function showsArtifactPriorityLabel(
  variant: ArtifactPriorityVariant,
  priority: string
): boolean {
  const { label } = ARTIFACT_PRIORITY_VARIANT_SPEC[variant];
  if (label === ArtifactPriorityLabelMode.Never) {
    return false;
  }
  if (label === ArtifactPriorityLabelMode.Always) {
    return true;
  }
  return priority !== DEFAULT_PRIORITY;
}

/**
 * Whether the champion may offer "no priority" on this row, read from the
 * surface's own support declaration rather than from a boolean each call site
 * decides for itself. An unsupported surface is not one that merely disallows
 * clearing — it carries no priority at all — so it can never offer the item.
 */
export function allowsArtifactPriorityUnset(
  support: ArtifactPrioritySupport
): boolean {
  return support.supported && support.allowsUnset;
}

/**
 * Whether this variant names an ABSENT priority in words rather than with the
 * empty-value mark alone.
 *
 * Two places need the same answer and must not derive it twice. The mark uses
 * it to decide whether to draw the word; a control wrapping that mark uses it to
 * decide whether to carry an `aria-label` at all, because WCAG 2.5.3 (Label in
 * Name) requires the accessible name to contain the visible label — an
 * `aria-label` of "Set priority" over a visible "No priority" leaves a
 * voice-control user unable to activate what they can read (ISS-9441).
 *
 * The dense {@link ArtifactPriorityShell.Cell} is excluded because it paints no
 * word for an absent value: its column header already names the concept, and a
 * page of unset rows repeating "No priority" is the noise ISS-9665 avoided.
 */
export function paintsArtifactPriorityAbsentLabel(
  variant: ArtifactPriorityVariant
): boolean {
  const { label, shell } = ARTIFACT_PRIORITY_VARIANT_SPEC[variant];
  return (
    label === ArtifactPriorityLabelMode.Always &&
    shell !== ArtifactPriorityShell.Cell
  );
}
