/** Lightweight shared contract for the artifact-status component's props and events. */

import type { NormalizedArtifactStatus } from "@repo/api/src/types/artifact-status";
import type {
  ArtifactStatusCapability,
  ArtifactStatusCommitFor,
  ArtifactStatusEditSurface,
  ArtifactStatusGroupedEditSurface,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";

/**
 * The nine approved variants, in PRD-714's order. One champion component
 * renders all of them; a variant is a prop, never a second component and never
 * a fixture-shaped prop bag.
 *
 * Wire-stable values: a variant reaches analytics and the conformance kit
 * (ISS-9438), so renaming one is a contract break.
 */
export const ArtifactStatusVariant = {
  Display: "display",
  Icon: "icon",
  Badge: "badge",
  CompactCell: "compact_cell",
  Editor: "editor",
  FilterOption: "filter_option",
  BulkOption: "bulk_option",
  BoardLane: "board_lane",
  DetailField: "detail_field",
} as const;
export type ArtifactStatusVariant =
  (typeof ArtifactStatusVariant)[keyof typeof ArtifactStatusVariant];

/**
 * A status with no artifact behind it: a filter facet, a bulk menu option, a
 * board lane header.
 *
 * Extracted from {@link ArtifactStatusView} (ISS-9301) because three of the
 * nine variants are about a STATUS and not about a row, and the only way to
 * satisfy a required `artifactId` on those is to invent one — the product lying
 * about its own data in the smallest possible way. A facet is what remains once
 * identity is removed, so the row type is this type plus identity rather than a
 * second declaration of the same three fields.
 *
 * `raw` rides along beside the normalized value because filters, tooltips and
 * the activity receipt all still speak raw, and `null` is the honest reading of
 * a row that stored no status at all. No variant renders `raw` as its label:
 * the label comes from `artifact-status-display.ts`, and a value that folded to
 * `unknown` gets ISS-9560's unknown render rather than its raw spelling echoed
 * back at the reader.
 */
export type ArtifactStatusFacet = Readonly<{
  normalized: NormalizedArtifactStatus;
  raw: string | null;
  vocabulary: ArtifactStatusVocabulary;
}>;

/**
 * One artifact's status. Structurally unchanged from what ISS-9300 shipped —
 * the same four fields, the same requiredness — so nothing about that ruling
 * moves; only its DERIVATION changed, to a facet plus identity.
 *
 * `artifactId` is here because the editor has to BUILD an
 * `ArtifactStatusCommit`, and a commit names the row it is about. Without it
 * the champion would have to take identity from a second prop or let the
 * caller's handler substitute its own payload, and the receipt's subject would
 * stop being something this contract guarantees. No variant renders it.
 */
export type ArtifactStatusView = ArtifactStatusFacet &
  Readonly<{ artifactId: string }>;

/**
 * The three variants that render a status with no row behind it.
 *
 * Enumerated rather than derived, because which side of the split a variant
 * falls on is a judgment about what it depicts, not something a type can
 * compute. {@link ArtifactStatusRowVariant} is then derived from this and the
 * editor, so a tenth variant added to {@link ArtifactStatusVariant} lands in
 * the row arm by default and has to be moved here deliberately.
 */
export type ArtifactStatusFacetVariant =
  | typeof ArtifactStatusVariant.FilterOption
  | typeof ArtifactStatusVariant.BulkOption
  | typeof ArtifactStatusVariant.BoardLane;

/** The five variants that depict one artifact's status and only read it. */
export type ArtifactStatusRowVariant = Exclude<
  ArtifactStatusVariant,
  ArtifactStatusFacetVariant | typeof ArtifactStatusVariant.Editor
>;

/**
 * Props for a read-only variant that depicts ONE ARTIFACT's status.
 *
 * Obligations the champion inherits for these variants: the accessible name
 * always carries the status WORD, never hue alone (UAS-007, WCAG 1.4.1), and a
 * value that folded to `unknown` renders honestly instead of blank (UAS-023).
 */
export type ArtifactStatusRowProps = Readonly<{
  view: ArtifactStatusView;
  variant: ArtifactStatusRowVariant;
}>;

/**
 * Props for a read-only variant that depicts A STATUS, with no artifact behind
 * it.
 *
 * The prop is named `facet` rather than `view` so the two arms are
 * structurally distinguishable and a caller cannot hand a lane header a row:
 * passing a full {@link ArtifactStatusView} here is accepted (it IS a facet),
 * but the id is not reachable from this arm, so no facet variant can grow a
 * dependency on identity it is not guaranteed to have.
 *
 * The same accessible-name and honest-unknown obligations apply as on
 * {@link ArtifactStatusRowProps}.
 */
export type ArtifactStatusFacetProps = Readonly<{
  facet: ArtifactStatusFacet;
  variant: ArtifactStatusFacetVariant;
}>;

/**
 * Props for every variant that only READS a status — the row arm or the facet
 * arm.
 *
 * `editor` is excluded at the type level rather than by convention, because an
 * editor rendered through this shape would have no capability and no commit
 * handler — which is exactly the "editable is whatever the parent happened to
 * pass" state {@link ArtifactStatusEditorProps} exists to end.
 */
export type ArtifactStatusDisplayProps =
  | ArtifactStatusRowProps
  | ArtifactStatusFacetProps;

/**
 * Props for the one variant that WRITES.
 *
 * `capability` and `onCommit` are both required, and that is the point of the
 * type. Today a control infers editability from whether an update handler was
 * passed, so "editable but refused" and "read-only because provider-derived"
 * have no representation at all; a required capability makes both unskippable
 * at compile time. `surface` is required for the same reason — a receipt that
 * cannot name where the write came from is what blocked ISS-9436 twice.
 *
 * `variant` is pinned to `editor` so this and {@link ArtifactStatusDisplayProps}
 * form a DISCRIMINATED union. Without it the champion's prop union has no tag
 * and a caller has to infer the mode from which handlers happen to be
 * present — the same "editability is whatever the parent passed" guess this
 * type exists to end.
 *
 * The surface is a TYPE PARAMETER, not merely a field, so the commit this
 * editor emits is the one its own `surface` admits. Optional-typed, an editor
 * rendered with `surface: "detail"` could emit a commit saying `"bulk"` and
 * typecheck, putting provenance on the receipt that names an endpoint the write
 * never touched. There is deliberately NO default: a default of the whole union
 * collapses the tie for every consumer who writes the bare name, which is every
 * consumer, and the guard would then fire only for someone who opted in. JSX
 * infers `S` from the `surface` prop, so the cost lands only on an explicit
 * annotation, where naming the surface is the point.
 *
 * Interaction obligations the champion must satisfy, recorded here so ISS-9301
 * and ISS-9438 inherit them rather than re-deriving them:
 *
 * - UAS-020 — keyboard open, navigate, commit and cancel.
 * - UAS-021 — focus returns to the trigger on commit AND on cancel. Nothing on
 *   main asserts this today.
 * - UAS-022 — optimistic apply with rollback on failure. The pattern is the
 *   detail surface's per-call `onError` restore of local state, already pinned
 *   by `use-update-document-rollback.test.tsx`; the inline-cell and bulk
 *   surfaces have neither today and adopt that one mechanism rather than a
 *   second.
 * - UAS-023 — a failed write is surfaced to the reader, never swallowed.
 * - UAS-024 — editability is read from `capability`, never from the presence of
 *   `onCommit`.
 *
 * `S` is narrowed to {@link ArtifactStatusSingleSubjectEditSurface}: one editor
 * instance rendered from one `view` cannot produce a GROUPED commit. See that
 * type for why, and for who keeps owning the two grouped surfaces.
 */
export type ArtifactStatusEditorProps<
  S extends ArtifactStatusSingleSubjectEditSurface,
> = Readonly<{
  variant: typeof ArtifactStatusVariant.Editor;
  view: ArtifactStatusView;
  capability: ArtifactStatusCapability;
  surface: S;
  onCommit: (commit: ArtifactStatusCommitFor<S>) => void;
  onCancel?: () => void;
  /** Field-qualified accessible name supplied by an embedding form. */
  ariaLabel?: string;
  /** Trigger identity supplied by an embedding form label. */
  triggerId?: string;
  /** Compact list rows keep the same editor menu with an icon-only trigger. */
  triggerVariant?: typeof ArtifactStatusVariant.Icon;
}>;

/**
 * The edit surfaces one editor instance can actually serve: every surface whose
 * commit names a single subject.
 *
 * `ArtifactStatusCommitFor<S>` requires a `commitGroupId` for `bulk` and
 * `board`, and every commit names exactly one `artifactId`. An editor rendered
 * from one {@link ArtifactStatusView} can see neither the other selected rows
 * nor an id that must be SHARED across them, so it cannot honestly build such a
 * commit — it would have to invent the group id, and a receipt whose group id
 * names only itself is worse than no grouping at all.
 *
 * Derived by `Exclude` from the shipped union rather than re-listed, so a sixth
 * edit surface is single-subject by default and becomes grouped only by being
 * added to `ArtifactStatusGroupedEditSurface` beside its reason. Note this
 * admits `row_action` as well as `detail` and `inline_cell`: the
 * archive/unarchive control writes one project through `PUT /projects/[id]`,
 * so it is single-subject on the same evidence the other two are.
 *
 * Nothing in the shipped contract is deleted by this narrowing:
 * `ArtifactStatusCommitFor<"bulk">` stays exactly as ISS-9300 defined it. The
 * bulk picker and the board keep owning their own fan-out, which is what they
 * do today, and consume the champion for option and lane visuals only.
 * Recorded for ISS-9304 and ISS-9436: whoever wires those two mints the
 * `commitGroupId`.
 */
export type ArtifactStatusSingleSubjectEditSurface = Exclude<
  ArtifactStatusEditSurface,
  ArtifactStatusGroupedEditSurface
>;
