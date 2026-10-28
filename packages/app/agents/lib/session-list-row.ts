import type { SessionProvenance } from "@repo/api/src/types/branch";
import type { Priority } from "@repo/api/src/types/common";
import type {
  ArtifactTagAvailability,
  ArtifactTagPermissions,
  TagSummary,
} from "@repo/api/src/types/tag";
import type { ReactNode } from "react";
import type { CostAvailability } from "./cost-availability";
import type { SessionRepositoryDisplay } from "./session-repository-label";
import type { SessionSyncPresentation } from "./session-sync-presentation";

/** Canonical display row consumed by both Sessions list hosts and the detail table. */
export type SessionTableRow = {
  id: string;
  name: string;
  /**
   * The recording user (ISS-12251 D-2), read as the Owner only when the
   * producer omits `assignee` (`sessionRowOwner`). `null` when no identity is
   * available.
   *
   * `id` is the person's IDENTITY and `name` is only how we spell it: two
   * different people can share a display name, so anything that groups or
   * de-duplicates owners keys on the id (#4480 review). Optional because a
   * projection that has only a name still renders the cell correctly.
   */
  user?: { id?: string; name: string; avatarUrl?: string | null } | null;
  /**
   * ISS-12251 D-1 (PLN-2176 T-4.1): the session's Owner, its artifact's
   * assignee. `null` when unassigned; absent when the producer does not serve
   * `assignee` (an older API), where every Owner
   * reader falls back to {@link user} through `sessionRowOwner` (AC-012). Same
   * shape and identity rule as {@link user}.
   */
  owner?: { id?: string; name: string; avatarUrl?: string | null } | null;
  /** Producer-owned evidence retained beside the derived display status. */
  rawStatus?: string | null;
  status: string;
  /**
   * ISS-4774 / ISS-4846 / ISS-5036 / ISS-5279: how this row's transport state
   * modulates the Status pill. Set by the shared row mapper
   * (`toSessionTableRowWithSyncFold`) only when the row's DISPLAYED run status
   * is Active; otherwise absent, so the Status cell renders the plain run status
   * exactly as before. (ISS-5366 retired the `sessions-status-pill-sync-state`
   * gate that used to be the other half of that condition.)
   *
   * It changes neither {@link status} NOR the pill's label. ISS-4848 stacked a
   * second "Syncing" pill beside the run-status one; ISS-5036 replaced the
   * run-status pill with it and moved liveness to a dot in the Name cell.
   * ISS-5279 does neither: the lifecycle word stays and sync rides on the pill's
   * presentation — a pulse, a tooltip, an accessible name. One pill, no dot, and
   * the Status column now reads the same value the Status facet filtered on and
   * the server-side Status sort ranked.
   */
  syncPresentation?: SessionSyncPresentation;
  /**
   * ISS-8712: the org tags applied to this row's Session artifact, and whether
   * the producer loaded that relation at all.
   *
   * Both optional and read TOGETHER, never separately: `tagAvailability` absent
   * or `Unavailable` means this producer never asked, which a cell must not
   * render as "no tags". Only `Available` licenses the empty state.
   */
  tags?: TagSummary[];
  tagAvailability?: ArtifactTagAvailability;
  /** Auth-derived tag capabilities; absent when the producer did not report them. */
  tagPermissions?: ArtifactTagPermissions;
  /**
   * ISS-10332: the Session artifact's priority. `null` is "no priority";
   * ABSENT is "this producer does not know" (an older API or Desktop build),
   * which the cell must not read as
   * unset — same three-state rule as the tag pair above.
   */
  priority?: Priority | null;
  harness: string;
  /** Producer-owned display branch for the session, if available. */
  branch?: string | null;
  /** Display-ready pull requests associated with this session. */
  pullRequests: {
    numberLabel: string;
    statusLabel: string;
    title: string;
    label: string;
  }[];
  /** Compact PR column label, or `null` when there are no associated PRs. */
  pullRequestSummaryLabel: string | null;
  /** Compact merge-state column label, or `null` when there are no PRs. */
  mergeStatusLabel: string | null;
  repo?: string | null;
  /**
   * ISS-4996: WHY {@link repo} has no label. Absent (no Git remote ever
   * resolved — the ordinary case, and the same fact as a null branch) renders
   * the shared em-dash empty glyph; malformed (a repository value WAS stored
   * but carries no identity) keeps the distinct word "Unknown".
   *
   * ISS-5366 retired the `sessions-honest-unknown-states` gate, and
   * `resolveSessionRepositoryDisplay` always returns a kind, so every shipping
   * row carries this. It stays optional only for hand-written row literals in
   * stories and tests, which render the ABSENT glyph — what a real row with no
   * repository renders — rather than a state of their own.
   */
  repositoryDisplay?: SessionRepositoryDisplay;
  model?: string | null;
  /**
   * FEA-4186: the Duration cell label, or `null` when the session has no
   * resolvable start bound — the cell then renders the shared `GridEmptyValue`
   * em-dash like every other optional column, rather than a raw hyphen string.
   */
  durationLabel: string | null;
  /**
   * ISS-8013: the SPAN {@link durationLabel} formats, in milliseconds — the
   * value the Duration column sorts on. `null` on an unmeasurable window, the
   * same fact the label's own `null` states.
   *
   * See {@link costValue} for why these five raw values exist at all, and why
   * they are optional.
   */
  durationMs?: number | null;
  costLabel: string;
  /**
   * ISS-8013: the figure {@link costLabel} formats — the value the Cost column
   * sorts on. `null` whenever the label is not a figure at all (see
   * `costLabelIsFigure`), so an unpriced row is unranked rather than ranked as
   * a free one.
   *
   * WHY A SECOND FIELD PER COLUMN. Cost, Duration, Started, Updated and Last
   * active are all `sortable: true`, and until ISS-8013 this row carried only
   * their LABELS, so `sortRows` compared display strings: `$1,234.00` ranked
   * below `$9.50` and `2h 40m` below `5m`. A comparator cannot repair that —
   * there was nothing on the row to sort by — and parsing the label back into a
   * number would make the sort depend on a formatter's punctuation. The value is
   * carried instead, beside the string it was formatted into.
   *
   * OPTIONAL, like {@link updatedLabel} and for the same reason: hand-written
   * story and test rows spell the display contract, not the derivation. A row
   * that omits it sorts as `null` — parked last in BOTH directions, never
   * ranked as a zero. The production path is one mapper
   * (`agentSessionToSessionTableRow`), and `session-table-row.test.ts` pins that
   * it fills all five.
   */
  costValue?: number | null;
  costTooltip?: string | null;
  costAvailability: CostAvailability;
  /**
   * ISS-4996: the Started cell label, or `null` when the session has no
   * resolvable start time — the cell then renders the shared `GridEmptyValue`
   * em-dash like every other optional column, rather than its own raw dash
   * string at a different size and opacity. Same treatment as `durationLabel`.
   */
  startedLabel: string | null;
  /**
   * ISS-8013: the INSTANT {@link startedLabel} renders, as epoch milliseconds —
   * the value the Started column sorts on. Epoch ms rather than a `Date` so all
   * five raw values are numbers and one comparator (`compareNullableNumber`)
   * orders every one of them. See {@link costValue}.
   */
  startedAtMs?: number | null;
  /**
   * PLN-1034: rendered most-recent-genuine-activity time; the default sort.
   * ISS-4996: `null` when there is no resolvable activity time — see
   * {@link startedLabel}.
   */
  lastActivityLabel: string | null;
  /**
   * ISS-8013: the INSTANT {@link lastActivityLabel} renders, as epoch
   * milliseconds — the value the Last active column sorts on. See
   * {@link costValue}.
   */
  lastActivityAtMs?: number | null;
  /**
   * ISS-6005: the `Updated` cell label — when the session RECORD was last
   * mutated in the database (`recordUpdatedAt`), as against
   * {@link lastActivityLabel} (the agent's own latest genuine activity).
   * Optional + nullable: absent or `null` (a version-skewed producer that does
   * not serve the field, or a hand-written story/test row) renders the shared
   * `GridEmptyValue` em dash — never a borrowed lookalike timestamp.
   */
  updatedLabel?: string | null;
  /**
   * ISS-8013: the INSTANT {@link updatedLabel} renders, as epoch milliseconds —
   * the value the Updated column sorts on. Read from `recordUpdatedAt`, the
   * same field the label comes from, so this column cannot quietly rank by the
   * activity timestamp the column beside it uses. See {@link costValue}.
   */
  updatedAtMs?: number | null;
  /** Autonomy score 0–100 (FEA-2094); `null`/absent when no metric is available. */
  autonomy?: number | null;
  /**
   * FEA-3575: session origin (`agent`/`bot`) surfaced as a lead chip so bot and
   * agent-driven runs are distinguishable from human work. Absent/`human` rows
   * render no chip (see `SessionProvenanceChip`).
   */
  provenance?: SessionProvenance | null;
};

/** Host-supplied linked-entity cell, optionally expanded for narrow cards. */
export type SessionsSeamCellRenderer = (
  row: SessionTableRow,
  options: Readonly<{ uncapped?: boolean }>
) => ReactNode;
