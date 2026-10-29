/** Lightweight cross-surface contract for reading and editing a normalized artifact status. */

import type {
  DocumentStatus,
  IssueStatus,
} from "@closedloop-ai/loops-api/document";
import type { BranchStatus } from "./branch.js";
import type { ProjectStatus } from "./project.js";
import type { SessionStatus } from "./session-status.js";

/**
 * ## Which layer owns what (ISS-9300's ownership ruling, PLN-1980)
 *
 * | Layer | Owner |
 * | --- | --- |
 * | Visual primitive | `packages/design-system/components/ui/status-icon.tsx` — project-agnostic, and gated from importing this module |
 * | Domain composition + variants | `packages/app` (`shared/lib/artifact-status-view-contract.ts`; the component is ISS-9301) |
 * | Raw → normalized mapping | `./artifact-status-mapping.ts` (ISS-9432) |
 * | Labels + the unknown render | `./artifact-status-display.ts` (ISS-9432) + ISS-9560 |
 * | Ordering | Root rank `./artifact-status-rank.ts` (ISS-9437); the raw tiebreaks under a root stay `statusDisplayRank` (`./artifact-status-display-order.ts`, ISS-9669) and `branchStatusRank` (`./branch-status-order.ts`) |
 * | Data access | `packages/app` / `apps/app` hooks → `apps/api` routes; no database read from the app package |
 * | Mutation + authority | `apps/api` (`PUT /documents/[id]`, `POST /documents/batch-update-status`), scope-based, server-enforced |
 * | Allowed transitions | Any status may move to any other in its own vocabulary (operator ruling 2026-09-11, ISS-9559). No origin-dependent matrix exists or is coming; the only narrowings are per-row and runtime — see {@link ArtifactStatusCapability.allowedTargets} |
 * | Activity receipt | `apps/api/lib/artifact-activity-capture.ts`, which ISS-9436 will route through {@link ArtifactStatusCommit} |
 * | Rollout flags | one PostHog key per perceivable change; cross-surface keys as `packages/api/src/types/<name>-flag.ts` |
 *
 * This module declares no fold, no rank and no copy. Each already has exactly
 * one owner above, and a second declaration here would be the parallel
 * implementation PRD-714 exists to remove.
 *
 * ## What authorizes a status write (ISS-9559)
 *
 * Two axes, both now stated rather than one. ISS-9433 shipped the SUBTYPE axis;
 * ISS-9559 added the PERMISSION axis, because a capability computed from
 * subtype alone told a read-scoped API key which statuses it "may" set on
 * routes that would 403 it. `DocumentStatusMutationCapability.permissions` in
 * `./document-status-mutation.ts` answers `single` and `bulk` separately, keyed
 * exhaustively by operation, and is what a producer folds into
 * {@link ArtifactStatusReadOnlyReason.NotPermitted} below rather than
 * recomputing scope itself.
 *
 * ORIGIN IS NOT AN AXIS. Any status may move to any other in its vocabulary
 * (operator ruling 2026-09-11). `allowedTargets` is therefore every value in
 * the row's subtype vocabulary, narrowed only at runtime: `not_permitted` when
 * the actor lacks the scope, `unrecognized_status` when the stored value folds
 * to `unknown`. Do not read the vocabulary's declaration order as a lifecycle
 * and infer a restriction from it — there is none to find, and a matrix that
 * refused a move would refuse writes that succeed today.
 *
 * `allowedTargets` has no server producer yet because it has no consumer yet;
 * it belongs with the surface that renders it (ISS-9307), built to the rule
 * above.
 */

/**
 * The five artifact vocabularies ISS-9432 shipped a fold table for. Names the
 * vocabulary only — the raw→normalized folds are `toArtifactStatusFrom*` in
 * `./artifact-status-mapping.ts`.
 *
 * No `inbox` and no `prototype`: neither has a production surface (D-07).
 */
export const ArtifactStatusVocabulary = {
  Document: "document",
  Issue: "issue",
  Branch: "branch",
  Project: "project",
  Session: "session",
} as const;
export type ArtifactStatusVocabulary =
  (typeof ArtifactStatusVocabulary)[keyof typeof ArtifactStatusVocabulary];

/**
 * Where a status write was made from. Exactly the five production write paths
 * on main, so a receipt can name the surface instead of inferring it:
 * `detail` (`use-document-metadata.ts` → `PUT /documents/[id]`), `inline_cell`
 * (`DocumentStatusControl` in the documents table → the same PUT), `board`
 * (the My Tasks kanban drag-drop → the same PUT), `bulk`
 * (`bulk-status-picker.tsx` → `POST /documents/batch-update-status`), and
 * `row_action` (the archive/unarchive menu item on the projects table and on
 * the project detail page, both `useUpdateProjectStatus` →
 * `PUT /projects/[id]`).
 *
 * `row_action` exists because the other four are all DOCUMENT routes, so a
 * project commit had no surface that named its own endpoint and the receipt
 * ISS-9436 is waiting on would have pointed at the wrong one. Marking `project`
 * read-only instead would have recorded something the product does not do.
 *
 * ISS-9436 stopped twice on "source surface cannot be carried" and routed the
 * taxonomy here. These are wire values reaching an activity receipt: renaming
 * one is a contract break, not a refactor.
 */
export const ArtifactStatusEditSurface = {
  Detail: "detail",
  InlineCell: "inline_cell",
  Board: "board",
  Bulk: "bulk",
  RowAction: "row_action",
} as const;
export type ArtifactStatusEditSurface =
  (typeof ArtifactStatusEditSurface)[keyof typeof ArtifactStatusEditSurface];

/**
 * Why a status cannot be written, in the reader's terms rather than the
 * implementation's. Two are STRUCTURAL — true of a whole vocabulary, and the
 * only two {@link ARTIFACT_STATUS_EDITABILITY} may use:
 *
 * - `provider_derived` — the value is a projection of evidence this product
 *   does not own (a branch's status is read off GitHub PR evidence).
 * - `machine_written` — ingest writes it (a session's lifecycle status).
 *
 * Two are per-ROW and runtime, carried on {@link ArtifactStatusCapability}
 * by the producer that computed them:
 *
 * - `not_permitted` — this actor may not write this row. The refusal is the
 *   server's to compute, exactly as `comment.canEdit` already is; this contract
 *   only guarantees the UI can state it honestly instead of inferring
 *   editability from whether a handler was passed.
 * - `unrecognized_status` — the row's stored value folded to `unknown`, so no
 *   honest transition can be offered FROM it. This is the degrade-honestly
 *   boundary: a version-skewed producer emitting a status this build has never
 *   heard of surfaces here as a refusal with a reason, never as a silently
 *   editable row offering transitions out of a state nobody could classify.
 */
export const ArtifactStatusReadOnlyReason = {
  ProviderDerived: "provider_derived",
  MachineWritten: "machine_written",
  NotPermitted: "not_permitted",
  UnrecognizedStatus: "unrecognized_status",
} as const;
export type ArtifactStatusReadOnlyReason =
  (typeof ArtifactStatusReadOnlyReason)[keyof typeof ArtifactStatusReadOnlyReason];

/**
 * Whether a whole vocabulary has a status a human may write at all, and if not,
 * why. A value rather than a boolean, so the refusal always arrives with its
 * reason attached.
 */
export type ArtifactStatusStructuralReadOnlyReason = Extract<
  ArtifactStatusReadOnlyReason,
  | typeof ArtifactStatusReadOnlyReason.ProviderDerived
  | typeof ArtifactStatusReadOnlyReason.MachineWritten
>;

export type ArtifactStatusEditability = Readonly<
  | { editable: true }
  | { editable: false; reason: ArtifactStatusStructuralReadOnlyReason }
>;

/**
 * The STATIC, per-vocabulary half of editability — what each artifact kind is
 * today, not what it should be.
 *
 * `branch` is read-only because there is no write route for branch status
 * anywhere under `apps/api/app/branches` — the value is read off GitHub PR
 * evidence and this product owns none of it.
 *
 * `session` is read-only for a different and narrower reason, and the
 * distinction matters to whoever builds the producer. A human write IS
 * reachable: `PATCH /agent-sessions/[id]` accepts `status` as an org-scoped
 * grouping field, so any member may set it, and that route's own docstring
 * calls it a UI-driven write. What it is not is DURABLE — the desktop ingest's
 * update arm rewrites `status` on the next sync of the same run, so an editor
 * here would show the reader a change that quietly disappears. `machine_written`
 * names the authority that wins, not the absence of a route. Do not read this
 * row as "no write path exists" and skip the route when wiring ISS-9433.
 *
 * Whether either SHOULD gain an editor is an open product question (PLN-1939
 * D-04) routed to ISS-9433 / ISS-9559; for `session` the blocker is ingest
 * precedence rather than this contract, and answering it yes is one row here
 * plus a server capability, not a change to this shape.
 * `project` is editable on evidence — `PUT /projects/[id]` plus the
 * archive/unarchive control — and not by symmetry with documents and issues.
 *
 * Only the two STRUCTURAL reasons may appear here. `not_permitted` and
 * `unrecognized_status` are per-row runtime facts; encoding either as a
 * vocabulary-wide one would make a single actor's refusal, or a single corrupt
 * row, look like a property of every artifact of that kind.
 *
 * ## How this relates to {@link ArtifactStatusCapability}
 *
 * This table is the static fact; a capability is the per-row runtime value a
 * producer returns. A capability may NARROW a vocabulary that is statically
 * editable — a document row this actor may not write, or one whose stored value
 * folded to `unknown`. It may not widen one that is not: a branch returned as
 * `{ editable: true }` would commit to a write route that does not exist.
 *
 * Nothing here enforces that, and this module deliberately does not try. A
 * vocabulary is a per-row runtime value rather than a static type parameter, so
 * no type can tie a capability to it without making every mixed-vocabulary
 * reader name one; and clamping at runtime would have to decide what a widened
 * capability DOES — coerce, refuse, or report — which is the producer's call.
 * Honouring this row is therefore an obligation on ISS-9433, not a guarantee of
 * {@link ArtifactStatusCapability}.
 */
export const ARTIFACT_STATUS_EDITABILITY: Readonly<
  Record<ArtifactStatusVocabulary, ArtifactStatusEditability>
> = Object.freeze({
  [ArtifactStatusVocabulary.Document]: Object.freeze({ editable: true }),
  [ArtifactStatusVocabulary.Issue]: Object.freeze({ editable: true }),
  [ArtifactStatusVocabulary.Branch]: Object.freeze({
    editable: false,
    reason: ArtifactStatusReadOnlyReason.ProviderDerived,
  }),
  [ArtifactStatusVocabulary.Project]: Object.freeze({ editable: true }),
  [ArtifactStatusVocabulary.Session]: Object.freeze({
    editable: false,
    reason: ArtifactStatusReadOnlyReason.MachineWritten,
  }),
});

/**
 * Every raw value one of the five vocabularies actually persists.
 *
 * The union exists so a write target is checked at compile time: `to` and
 * `allowedTargets` land in a column, and as bare `string` a misspelling like
 * `"IN_PRGORESS"` typechecked all the way to the database. This pins which
 * values exist at all; every one of them is legal from every other in the same
 * vocabulary, so there is no second, origin-dependent question behind it.
 *
 * `SessionStatus` rather than `DisplayedSessionStatus`: the displayed set adds
 * `waiting`, `unknown` and `stale`, which no producer originates and no column
 * stores — `PATCH /agent-sessions/[id]` rejects them rather than folding them.
 */
export type ArtifactStatusRawValue =
  | DocumentStatus
  | IssueStatus
  | BranchStatus
  | ProjectStatus
  | SessionStatus;

/**
 * The RUNTIME, per-row half of editability, supplied by the server beside the
 * row it describes (ISS-9433). It may narrow {@link ARTIFACT_STATUS_EDITABILITY};
 * not widening it is that producer's obligation, unenforced here for the reason
 * recorded on that table.
 *
 * `allowedTargets` are RAW vocabulary values — the strings a write actually
 * stores — and never normalized roots, which no column persists. Which values
 * belong there is settled above: the row's whole subtype vocabulary, narrowed
 * only by permission and by an unrecognized stored value. The element type is
 * {@link ArtifactStatusRawValue}, the union of
 * every value the five vocabularies persist, so a typo cannot reach a column;
 * it deliberately does not narrow to the row's OWN vocabulary, because that
 * would need the vocabulary as a static type parameter and every
 * mixed-vocabulary reader would have to name one. An empty array is meaningful
 * and honest: editable in principle, with nothing legal to move to right now.
 *
 * A capability is REQUIRED wherever an editor renders. Editability today is
 * inferred from whether an update handler was passed down, which can express
 * neither "editable but refused" nor "read-only because provider-derived";
 * requiring this value makes both states unskippable at compile time.
 */
export type ArtifactStatusCapability = Readonly<
  | { editable: true; allowedTargets: readonly ArtifactStatusRawValue[] }
  | { editable: false; reason: ArtifactStatusReadOnlyReason }
>;

/**
 * What one status write states, and what an activity receipt records about it.
 *
 * `from` is nullable because a row whose stored value was absent has no prior
 * status to name, and `null` says that rather than inventing one. `to` is a raw
 * vocabulary value for the same reason `allowedTargets` is.
 *
 * `commitGroupId` is one id shared by every row of a `bulk` or `board` commit,
 * so a receipt reader can tell a ten-row drag from ten separate edits. That is
 * the whole job of the field, so the two grouped surfaces REQUIRE it and the
 * single-row surfaces forbid it (`?: never`) rather than merely tolerating its
 * absence — optional everywhere, a bulk write that omitted it typechecked and
 * the receipt could no longer tell the ten rows from ten independent edits. It
 * stays absent rather than `null` on a single-row commit, which is what keeps
 * it additive for a version-skewed consumer.
 *
 * `from` stays a bare `string` while `to` is narrowed: a PRIOR value may be one
 * this build has never heard of — a version-skewed producer, or a row written
 * before a vocabulary changed — and that is exactly the case
 * `unrecognized_status` exists to represent. A write TARGET has no such excuse.
 *
 * ISS-9436 decided the provenance question this block used to leave open: an
 * ENVELOPE on the activity record's existing `before`/`after` JSON, not a new
 * column. The receipt shape and its builders are
 * `ArtifactStatusReceiptSnapshot` in `./artifact-activity.ts`. A column would
 * have had to be backfilled NULL across every row already written, and the
 * reader already unwraps a `{ field, value }` envelope; the envelope adds the
 * provenance keys beside `value` and a producer that knows no surface keeps
 * emitting exactly the bare string it emits today. This module still writes no
 * schema. Whether a REFUSED attempt is recorded at all remains an open product
 * question, and is still deliberately not answered by this type — which is why
 * `ArtifactStatusCommitResult` has exactly one member.
 */
export type ArtifactStatusGroupedEditSurface =
  | typeof ArtifactStatusEditSurface.Board
  | typeof ArtifactStatusEditSurface.Bulk;

export type ArtifactStatusCommitSubject = Readonly<{
  artifactId: string;
  vocabulary: ArtifactStatusVocabulary;
  from: string | null;
  to: ArtifactStatusRawValue;
}>;

/**
 * One surface's commit shape. Distributive, so handing it the whole
 * {@link ArtifactStatusEditSurface} union yields {@link ArtifactStatusCommit}
 * and handing it one member yields only that member's arm — which is what lets
 * an editor's `onCommit` be tied to the `surface` it was rendered with instead
 * of accepting any commit and trusting the caller to agree with itself.
 */
export type ArtifactStatusCommitFor<S extends ArtifactStatusEditSurface> =
  S extends ArtifactStatusGroupedEditSurface
    ? ArtifactStatusCommitSubject &
        Readonly<{ surface: S; commitGroupId: string }>
    : ArtifactStatusCommitSubject &
        Readonly<{ surface: S; commitGroupId?: never }>;

export type ArtifactStatusCommit =
  ArtifactStatusCommitFor<ArtifactStatusEditSurface>;

/**
 * The surfaces that commit ONE row at a time — every member that is not
 * grouped. Derived by {@link Exclude} rather than listed, so adding a member to
 * {@link ArtifactStatusEditSurface} cannot silently leave it out of both halves.
 */
export type ArtifactStatusSingleEditSurface = Exclude<
  ArtifactStatusEditSurface,
  ArtifactStatusGroupedEditSurface
>;

/**
 * What a producer carries to say WHERE a status write came from, with the group
 * id bound to the surface that requires it.
 *
 * The two fields travel together, as one discriminated value, because carrying
 * them as independent optionals let a caller state a combination the commit
 * contract rules out: a `board` or `bulk` write with no `commitGroupId` (which
 * {@link ArtifactStatusCommitFor} REQUIRES, and whose absence makes a ten-row
 * drag indistinguishable from ten separate edits), or a `detail` write carrying
 * one. Modelled here so that mistake fails `tsc` at the boundary instead of
 * reaching a persisted receipt.
 */
export type ArtifactStatusProvenance = Readonly<
  | { surface: ArtifactStatusSingleEditSurface; commitGroupId?: never }
  | { surface: ArtifactStatusGroupedEditSurface; commitGroupId: string }
>;
