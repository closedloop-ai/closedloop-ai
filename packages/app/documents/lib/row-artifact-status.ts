import type { NormalizedArtifactStatus } from "@repo/api/src/types/artifact-status";
import {
  toArtifactStatusFromProject,
  toArtifactStatusFromPullRequestState,
  toArtifactStatusFromSession,
  toDisplayedArtifactStatus,
} from "@repo/api/src/types/artifact-status-mapping";
import { normalizeDisplayedSessionStatus } from "@repo/api/src/types/session-status";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  normalizeBranchStatus,
  type RowTypeConfigOptions,
  resolveServedSessionDisplayStatus,
} from "@repo/app/documents/components/table/row-type-registry";
import { documentRowStatusEvidence } from "@repo/app/documents/lib/artifact-row-adapter";

/**
 * ISS-9437 — the normalized artifact status of ONE mixed-table row, whatever
 * kind it is.
 *
 * `Artifact.status` is a freeform column carrying four unrelated vocabularies in
 * this table: a `DocumentStatus`, an `IssueStatus`, a `GitHubPRState` on a branch
 * row, a harness string on a session row, plus `ProjectStatus` on the project
 * rows the table also renders. `statusDisplayRank` only knows the first two, so
 * every other row is a rank MISS and they all tie. Folding each kind onto its
 * normalized root through `@repo/api/src/types/artifact-status-mapping` is what
 * lets a `MERGED` branch row sort inside the `done` band instead of after it.
 *
 * ## The fold reads exactly what the RENDER reads
 *
 * The session arm is the load-bearing one. `getRowTypeConfig` resolves a session
 * row's displayed status as `options.sessionDisplayedStatus ?? the stored column`,
 * and that first term is only supplied when ISS-8694 is ON at the render site.
 * This fold takes the SAME {@link RowTypeConfigOptions} and applies the SAME
 * expression, so a row cannot sort in one band while its own icon and label say
 * another — the ISS-9669 defect this ticket must not reintroduce, one vocabulary
 * further down.
 *
 * That agreement only holds if the caller resolves the options once, ABOVE the
 * sort, and hands the same value to both. {@link SERVED_SESSION_STATUS_ROW_OPTIONS}
 * and {@link STORED_SESSION_STATUS_ROW_OPTIONS} are the two whole shapes a surface
 * picks between at its own ISS-8694 read site, so no boolean crosses into this
 * module to be re-derived here (`no-threaded-feature-flag`).
 */
export function rowArtifactStatus(
  item: DocumentRowItem,
  options: RowTypeConfigOptions = {}
): NormalizedArtifactStatus {
  switch (item.kind) {
    case "document":
      // Covers Documents AND Issues (PRD-495); the subtype picks the vocabulary.
      return toDisplayedArtifactStatus(
        item.data.type,
        rowArtifactStatusEvidence(item, options)
      );
    case "project":
      return toArtifactStatusFromProject(item.data.status);
    case "branch":
      // A branch row carries a raw `GitHubPRState`, not a `BranchStatus`, so it
      // goes through the recognizer the row's own icon and label already use.
      return toArtifactStatusFromPullRequestState(
        normalizeBranchStatus(item.data.status)
      );
    case "session":
      return toArtifactStatusFromSession(
        resolveSessionDisplayStatus(item, options)
      );
    default: {
      // Exhaustiveness check: a new row kind must be handled explicitly.
      const unhandled: never = item;
      return unhandled;
    }
  }
}

/**
 * Returns the exact evidence the champion groups and sorts for one mixed-table
 * row. Legacy document fallbacks remain on `data.status`; the enabled ordering
 * asks this seam for retained wire evidence instead.
 */
export function rowArtifactStatusEvidence(
  item: DocumentRowItem,
  options: RowTypeConfigOptions = {}
): string | null | undefined {
  switch (item.kind) {
    case "document":
      return documentRowStatusEvidence(item.data);
    case "project":
      return item.data.status;
    case "branch":
      return normalizeBranchStatus(item.data.status);
    case "session":
      return resolveSessionDisplayStatus(item, options);
    default: {
      const unhandled: never = item;
      return unhandled;
    }
  }
}

/**
 * How a surface resolves the per-row {@link RowTypeConfigOptions} that both the
 * fold above and `getRowTypeConfig` consume. A function of the ROW, never of a
 * flag: the flag picks which of the two implementations below is in play.
 */
export type RowTypeConfigOptionsResolver = (
  item: DocumentRowItem
) => RowTypeConfigOptions;

/**
 * ISS-8694 OFF: the stored `status` column decides, which is what every call site
 * did before that field existed. One frozen object, so the resolver's result has
 * a stable identity and a memo keyed on it is not invalidated per row.
 */
export const STORED_SESSION_STATUS_ROW_OPTIONS: RowTypeConfigOptionsResolver =
  () => NO_ROW_TYPE_CONFIG_OPTIONS;

/**
 * ISS-8694 ON: the row's SERVED display status decides, when it carries one.
 *
 * Deliberately the same expression `ArtifactNameCell` builds at its own flag read
 * site (`cells/name-cell.tsx`) rather than a second spelling of it —
 * `resolveServedSessionDisplayStatus` already owns which served values may be
 * admitted, and a second opinion about that is how the fold and the render come
 * to disagree about one row.
 */
export const SERVED_SESSION_STATUS_ROW_OPTIONS: RowTypeConfigOptionsResolver = (
  item
) => ({ sessionDisplayedStatus: resolveServedSessionDisplayStatus(item) });

const NO_ROW_TYPE_CONFIG_OPTIONS: RowTypeConfigOptions = Object.freeze({});

/**
 * Byte-identical to the `session` arm of `getRowTypeConfig`. Kept as one
 * expression in one place because the two must not drift: a difference here is
 * invisible until a row sorts into a band its own badge contradicts.
 */
function resolveSessionDisplayStatus(
  item: Extract<DocumentRowItem, { kind: "session" }>,
  options: RowTypeConfigOptions
) {
  return (
    options.sessionDisplayedStatus ??
    normalizeDisplayedSessionStatus(item.data.status.toLowerCase())
  );
}
