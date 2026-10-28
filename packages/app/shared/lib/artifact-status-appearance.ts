/**
 * @file artifact-status-appearance.ts
 * @description The ONE registry mapping the normalized artifact-status
 * vocabulary to a visual mark (PRD-714 / ISS-9301). ISS-9432 shipped the roots
 * and details, ISS-9560 the labels, ISS-9557 the appearance NAMES and the one
 * drawing primitive — but nothing on main maps a normalized root or detail onto
 * an appearance, because every status pixel today is drawn by a per-vocabulary
 * adapter keyed on a RAW value. This module is that missing map.
 *
 * It lives in `packages/app` rather than the design system because it is
 * DOMAIN: `packages/design-system` is gated from importing `@repo/api`, and the
 * names it owns are deliberately domain-free. It lives in `shared/lib` rather
 * than a feature slice because `packages/app/AGENTS.md` -> Dependency Direction
 * forbids `shared/*` importing a slice, and the champion this feeds is shared.
 *
 * Pure: no React, no `"use client"`, type-only imports of the two visual
 * vocabularies. The sibling of `artifact-status-view-contract.ts` and
 * `@repo/api/src/types/artifact-status-display-order.ts`.
 *
 * ## Two axes, because the repo draws status two ways
 *
 * A GLYPH (`StatusAppearance` — Documents, Issues and Sessions draw one) and a
 * TONE (the `Badge`/`Chip`/`ToneLabel` variant — Branches draw one, through
 * `renderBranchStatus`). A registry carrying only the glyph would force every
 * Branch surface to keep its own tone table, which is the parallel
 * implementation PRD-714 exists to remove.
 *
 * ## Transitional coexistence
 *
 * Seven raw-keyed tables still draw every status pixel on main and are NOT
 * re-pointed by this ticket (ISS-9304 owns that), so two sources describe the
 * same marks until it lands. Nothing here is tested against them: the champion
 * is this registry's only reader and nothing MOUNTS the champion, so a
 * divergence changes no pixel, and a test asserting one frozen table equals
 * another is those tables written twice. The
 * reconciliation is ISS-9304's, at the point it re-points the consumers and a
 * mismatch becomes a real regression — including six Document/Issue tones that
 * genuinely differ from `shared/components/status-badge.tsx` and need a product
 * decision before either can win. Both are recorded on that ticket.
 */

import type {
  ArtifactStatusDetail,
  DisplayedArtifactStatus,
} from "@repo/api/src/types/artifact-status";
import {
  ARTIFACT_STATUS_DETAIL,
  DISPLAYED_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import type { StatusAppearance } from "@repo/design-system/components/ui/status-icon-primitives";
import type { ToneLabelVariant } from "@repo/design-system/components/ui/tone-label";
import type { ArtifactStatusFacet } from "./artifact-status-view-contract";

/**
 * The tone half of a mark: the SAME variant vocabulary `Badge`, `Chip` and
 * `ToneLabel` already share, aliased rather than re-declared so a retuned or
 * added variant reaches this registry without a second edit.
 */
export type ArtifactStatusTone = ToneLabelVariant;

/** What one normalized status draws: a glyph and a tone. */
export type ArtifactStatusMark = Readonly<{
  appearance: StatusAppearance;
  tone: ArtifactStatusTone;
}>;

/**
 * The mark for a status whose ROOT is all we know — a raw value that folded to
 * a root with no detail, which is the `IssueStatus` spine plus the session
 * `unknown` row.
 *
 * Exhaustive `Record`, so a seventh displayed root fails `tsc` here rather than
 * reaching a silent default at render time.
 *
 * `unknown` draws `muted-half-ring`, not `blank-ring`: that is what a session
 * whose displayed status is `unknown` draws today, through
 * `SESSION_STATUS_TO_ICON` -> `decorative` -> `STATUS_APPEARANCE`. `blank-ring`
 * is the DocumentStatusIcon/IssueStatusIcon fallback for a string outside their
 * enums, and no member of any vocabulary folds onto it, so this registry has no
 * row that draws it.
 */
export const ARTIFACT_STATUS_ROOT_APPEARANCE: Readonly<
  Record<DisplayedArtifactStatus, ArtifactStatusMark>
> = Object.freeze({
  [DISPLAYED_ARTIFACT_STATUS.Todo]: Object.freeze({
    appearance: "empty-ring",
    tone: "muted",
  }),
  [DISPLAYED_ARTIFACT_STATUS.InProgress]: Object.freeze({
    appearance: "half-ring",
    tone: "info",
  }),
  [DISPLAYED_ARTIFACT_STATUS.InReview]: Object.freeze({
    appearance: "three-quarter-ring",
    tone: "warning",
  }),
  [DISPLAYED_ARTIFACT_STATUS.Done]: Object.freeze({
    appearance: "success-check",
    tone: "success",
  }),
  [DISPLAYED_ARTIFACT_STATUS.Canceled]: Object.freeze({
    appearance: "foreground-x",
    tone: "muted",
  }),
  [DISPLAYED_ARTIFACT_STATUS.Unknown]: Object.freeze({
    appearance: "muted-half-ring",
    tone: "muted",
  }),
});

/**
 * The mark for a status whose raw value carried a distinction its root does
 * not. Keyed by the detail, whose keys are vocabulary-namespaced
 * (`document.drafting`, `branch.merged`) and therefore cannot collide.
 *
 * Exhaustive `Record`, so a new detail fails `tsc` here.
 *
 * The BRANCH rows' tones are not a preference: they are
 * `BRANCH_STATUS_CONFIG[...].variant` in `packages/app/branches/lib/branch-row.ts`,
 * which is what Branch surfaces draw today.
 *
 * Document and Issue statuses carry a shipped tone too — `artifactStatusColors`
 * and `issueStatusColors` in `shared/components/status-badge.tsx`, whose
 * `COLOR_*` class strings fill from the same DS tokens this vocabulary names.
 * This registry reproduces them on every row but six: two of those follow from
 * the rulings stated below (changes requested is one concept and one tone;
 * blocked is not rejected), and the other four are the root spine answering a
 * tone the badge palette does not share, with no ruling behind them. ISS-9301
 * re-points nothing, so no chip moves and nothing holds this registry against
 * those badges; settling the four unruled rows is ISS-9304's, before it
 * re-points them. Nothing assigns a tone to a Project or Session status.
 */
export const ARTIFACT_STATUS_DETAIL_APPEARANCE: Readonly<
  Record<ArtifactStatusDetail, ArtifactStatusMark>
> = Object.freeze({
  [ARTIFACT_STATUS_DETAIL.DocumentDrafting]: Object.freeze({
    appearance: "empty-ring",
    tone: "info",
  }),
  // `warning-exclamation` is the glyph both changes-requested details and
  // `issue.blocked` draw; the TONE is what parts them. Changes requested is
  // `destructive` on both vocabularies — one concept, one tone, and the branch
  // half of that is what `BRANCH_STATUS_CONFIG` already draws.
  [ARTIFACT_STATUS_DETAIL.DocumentChangesRequested]: Object.freeze({
    appearance: "warning-exclamation",
    tone: "destructive",
  }),
  [ARTIFACT_STATUS_DETAIL.DocumentApproved]: Object.freeze({
    appearance: "full-ring",
    tone: "success",
  }),
  [ARTIFACT_STATUS_DETAIL.DocumentExecuted]: Object.freeze({
    appearance: "success-check",
    tone: "success",
  }),
  [ARTIFACT_STATUS_DETAIL.DocumentSuperseded]: Object.freeze({
    appearance: "foreground-x",
    tone: "muted",
  }),
  // `ai-swap` fills from `--ai`, so the tone that matches the glyph it is drawn
  // beside is `ai` rather than a neutral.
  [ARTIFACT_STATUS_DETAIL.IssueTriage]: Object.freeze({
    appearance: "ai-swap",
    tone: "ai",
  }),
  [ARTIFACT_STATUS_DETAIL.IssueBacklog]: Object.freeze({
    appearance: "dashed-ring",
    tone: "muted",
  }),
  // Blocked is not rejected: it keeps `warning`, where changes-requested takes
  // `destructive`.
  [ARTIFACT_STATUS_DETAIL.IssueBlocked]: Object.freeze({
    appearance: "warning-exclamation",
    tone: "warning",
  }),
  [ARTIFACT_STATUS_DETAIL.BranchDraft]: Object.freeze({
    appearance: "empty-ring",
    tone: "muted",
  }),
  [ARTIFACT_STATUS_DETAIL.BranchPrOpen]: Object.freeze({
    appearance: "half-ring",
    tone: "info",
  }),
  [ARTIFACT_STATUS_DETAIL.BranchReview]: Object.freeze({
    appearance: "three-quarter-ring",
    tone: "warning",
  }),
  [ARTIFACT_STATUS_DETAIL.BranchChangesRequested]: Object.freeze({
    appearance: "warning-exclamation",
    tone: "destructive",
  }),
  [ARTIFACT_STATUS_DETAIL.BranchMerged]: Object.freeze({
    appearance: "success-check",
    tone: "success",
  }),
  [ARTIFACT_STATUS_DETAIL.BranchClosedWithoutMerge]: Object.freeze({
    appearance: "foreground-x",
    tone: "muted",
  }),
  [ARTIFACT_STATUS_DETAIL.ProjectArchived]: Object.freeze({
    appearance: "success-check",
    tone: "muted",
  }),
  [ARTIFACT_STATUS_DETAIL.SessionRunning]: Object.freeze({
    appearance: "half-ring",
    tone: "info",
  }),
  [ARTIFACT_STATUS_DETAIL.SessionCompleted]: Object.freeze({
    appearance: "success-check",
    tone: "success",
  }),
  [ARTIFACT_STATUS_DETAIL.SessionFailed]: Object.freeze({
    appearance: "destructive-bolt",
    tone: "destructive",
  }),
});

/**
 * The ONE place normalization loses a distinction the product draws, kept
 * expressible instead of flattened.
 *
 * A Document `IN_REVIEW` and an Issue `IN_REVIEW` both fold to
 * `{ root: "in_review" }` with no detail, and they draw different marks today:
 * `half-ring` against `three-quarter-ring`. `issue-status-icon.tsx` states that
 * as a ruling — "the two vocabularies share that word and not that mark, which
 * a shared appearance name has to keep expressible rather than flatten" — so
 * the divergence is reproduced here rather than resolved in favour of one
 * vocabulary.
 *
 * Overrides the ROOT answer only; see {@link resolveArtifactStatusMark} for why
 * a detail still wins over it. Typed `Partial` on both axes so it cannot be
 * mistaken for another per-vocabulary table, and the test asserts it holds
 * EXACTLY one entry so it cannot grow into one unnoticed. A second row here
 * needs the same kind of citation this one has.
 */
export const ARTIFACT_STATUS_VOCABULARY_OVERRIDE: Readonly<
  Partial<
    Record<
      ArtifactStatusVocabulary,
      Partial<Record<DisplayedArtifactStatus, ArtifactStatusMark>>
    >
  >
> = Object.freeze({
  [ArtifactStatusVocabulary.Document]: Object.freeze({
    [DISPLAYED_ARTIFACT_STATUS.InReview]: Object.freeze({
      appearance: "half-ring",
      tone: "warning",
    }),
  }),
});

/**
 * The mark one facet draws: its DETAIL's, else its vocabulary's override of the
 * root, else the root's.
 *
 * ## Why detail precedes the override
 *
 * The override is keyed by ROOT, so consulting it first would capture every
 * Document status sharing that root — and `DocumentStatus.ChangesRequested`
 * folds to `{ root: "in_review", detail: "document.changes_requested" }`. It
 * would then draw `half-ring` instead of the `warning-exclamation` it draws
 * today, silently losing a distinction the raw value DID carry. A detail is a
 * more specific statement than a root, so it wins; the override exists only to
 * disambiguate the case where two vocabularies fold to the same root with no
 * detail at all, which is exactly the Document/Issue `IN_REVIEW` split.
 *
 * ## A detail only wins for ITS OWN vocabulary
 *
 * `ARTIFACT_STATUS_DETAIL_APPEARANCE` is keyed by detail alone, so a lookup that
 * consulted it without checking ownership would let a FOREIGN detail answer: a
 * Session facet carrying `document.approved` would draw the Document
 * success-check, stating an outcome for a row nothing measured. A facet is
 * assembled by its caller from a fold plus a vocabulary, and the two arrive as
 * separate fields — the nine variants and the adapters ISS-9302/9304 add are
 * all places where the wrong fold can be paired with the right vocabulary. That
 * is not hypothetical: this ticket's own test helper shipped with Project wired
 * to the Document fold, and nothing went red.
 *
 * So a mismatched pair falls through to the root rather than borrowing another
 * vocabulary's mark. The root is the half both vocabularies genuinely agree on,
 * which makes the degraded answer honest rather than merely different.
 *
 * The check reads {@link DETAIL_VOCABULARY}, derived from the detail keys' own
 * namespace rather than hand-written, so it states no fact twice. It does NOT
 * also check the detail against `root`: which root a detail belongs to is
 * `artifact-status-mapping.ts`'s to say, and restating it here would be the
 * second declaration this registry exists to remove.
 *
 * Every lookup goes through `Object.hasOwn`. `raw` is a freeform column and the
 * normalized value riding beside it came from a fold over one, so `detail` can
 * in principle carry any string across a version-skewed boundary —
 * `"constructor"` and `"toString"` are legal ones, and a bare index on an
 * object literal returns a FUNCTION for them where the caller expects a mark.
 * This is the guard `artifact-status-display.ts` states the reason for and the
 * two per-type status icons already apply.
 *
 * Fails to the `unknown` root's mark rather than throwing: a status this build
 * cannot place still has to render something, and the muted marker is the
 * honest one.
 */
export function resolveArtifactStatusMark(
  facet: ArtifactStatusFacet
): ArtifactStatusMark {
  const { detail, root } = facet.normalized;

  if (
    detail != null &&
    Object.hasOwn(ARTIFACT_STATUS_DETAIL_APPEARANCE, detail) &&
    artifactStatusDetailBelongsTo(detail, facet.vocabulary)
  ) {
    return ARTIFACT_STATUS_DETAIL_APPEARANCE[detail];
  }

  const vocabularyOverride = Object.hasOwn(
    ARTIFACT_STATUS_VOCABULARY_OVERRIDE,
    facet.vocabulary
  )
    ? ARTIFACT_STATUS_VOCABULARY_OVERRIDE[facet.vocabulary]
    : undefined;

  if (vocabularyOverride != null && Object.hasOwn(vocabularyOverride, root)) {
    const overridden = vocabularyOverride[root];
    if (overridden != null) {
      return overridden;
    }
  }

  if (Object.hasOwn(ARTIFACT_STATUS_ROOT_APPEARANCE, root)) {
    return ARTIFACT_STATUS_ROOT_APPEARANCE[root];
  }

  return ARTIFACT_STATUS_ROOT_APPEARANCE[DISPLAYED_ARTIFACT_STATUS.Unknown];
}

/**
 * Which vocabulary each detail belongs to, read off the detail's own namespace
 * rather than written out a second time.
 *
 * `ARTIFACT_STATUS_DETAIL`'s values are namespaced by the vocabulary that
 * produced them (`document.drafting`, `session.failed`) — `artifact-status.ts`
 * states that as the rule, not as an accident of spelling. Deriving from it
 * means a detail added there arrives here with no edit, and a detail spelled
 * outside the convention is caught by the test that asserts every prefix
 * resolves to a real vocabulary, rather than silently resolving to nothing and
 * making every detail foreign.
 */
const DETAIL_VOCABULARY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.values(ARTIFACT_STATUS_DETAIL).map((detail) => [
      detail,
      detail.slice(0, detail.indexOf(".")),
    ])
  )
);

/**
 * Whether `detail` is one `vocabulary` produces. See the resolver's docblock for
 * why a foreign detail is refused.
 *
 * Exported because the champion's WORD has to degrade with its MARK: a label
 * read straight from the detail table would state a Document outcome beside the
 * root's muted marker for a row nothing measured. Its one consumer is
 * `shared/components/artifact-status/artifact-status-presentation.ts`, which
 * reads this rather than restating the namespace convention.
 */
export function artifactStatusDetailBelongsTo(
  detail: ArtifactStatusDetail,
  vocabulary: string
) {
  return (
    Object.hasOwn(DETAIL_VOCABULARY, detail) &&
    DETAIL_VOCABULARY[detail] === vocabulary
  );
}
