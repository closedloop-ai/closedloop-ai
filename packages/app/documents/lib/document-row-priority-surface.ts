import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  type ArtifactPrioritySupport,
  ArtifactPrioritySurface,
} from "@repo/app/shared/lib/artifact-priority-ownership";

/**
 * ISS-9307 — the typed adapter from a grid row's kind to the priority support
 * declaration for its surface.
 *
 * The artifact grid renders four row kinds and the priority contract declares
 * four surfaces, and until now the cell decided what to offer from a hand-rolled
 * `item.kind !== "project"`. That expression answers "may this row be cleared?"
 * by naming the one exception, so a branch or session row read as clearable, and
 * a fifth kind would have too.
 *
 * Routing through the declaration keeps the contract load-bearing: what a row
 * kind carries is whatever `ARTIFACT_PRIORITY_SUPPORT` says for its surface,
 * never a second copy at the call site — so when ISS-10332 (2026-09-21)
 * superseded the 2026-09-11 ruling and made branch and session rows carry a
 * priority, only the declaration changed.
 */
export function documentRowPrioritySupport(
  kind: DocumentRowKind
): ArtifactPrioritySupport {
  return ARTIFACT_PRIORITY_SUPPORT[DOCUMENT_ROW_PRIORITY_SURFACE[kind]];
}

/**
 * Read off the row union itself rather than re-listed, so a row kind added to
 * the grid fails typecheck in the map below instead of falling through to a
 * default and quietly taking some other surface's declaration.
 */
export type DocumentRowKind = DocumentRowItem["kind"];

/**
 * Exhaustive by type both ways: a row kind added to the grid fails typecheck
 * until it names a surface, and a surface renamed in the contract fails here
 * rather than silently mapping to nothing.
 */
const DOCUMENT_ROW_PRIORITY_SURFACE: Readonly<
  Record<DocumentRowKind, ArtifactPrioritySurface>
> = {
  // "document" covers both Documents and Features (PRD-495); both are artifacts.
  document: ArtifactPrioritySurface.Artifact,
  project: ArtifactPrioritySurface.Project,
  branch: ArtifactPrioritySurface.Branch,
  session: ArtifactPrioritySurface.Session,
};
