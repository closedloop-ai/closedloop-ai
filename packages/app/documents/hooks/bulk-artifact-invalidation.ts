// Feature-slice imports, deliberately: `packages/app/AGENTS.md` reserves
// `shared/` for code that never reaches into a slice, and this registry has to
// name one family per slice. Documents owns it because the artifact keys, the
// favorites list and the lineage views it narrows all live here.
import type { QueryClient } from "@tanstack/react-query";
import { agentSessionKeys } from "../../agents/hooks/agent-session-keys";
import { branchRowQueryKeys } from "../../branches/hooks/branch-query-keys";
import { projectKeys } from "../../projects/hooks/project-keys";
import { projectTreeKeys } from "../../projects/hooks/project-tree-keys";
import { artifactFavoriteKeys } from "./artifact-favorite-keys";
import { documentKeys } from "./document-keys";
import {
  invalidateAllArtifactLinkQueries,
  invalidateArtifactLinkQueries,
} from "./use-artifact-links";

/**
 * What a bulk mutation's response says it committed (ISS-9578).
 *
 * Only ids the server reported as committed belong here: a requested id the
 * server did not name is not a commit, and a bare count cannot drive the
 * per-id half of the set below.
 */
export type BulkArtifactReceipt = {
  readonly committedIds: readonly string[];
};

export type BulkArtifactInvalidationOptions = {
  /**
   * Refresh every artifact-link view instead of only those naming a committed
   * id. Set it where the server can move an artifact the receipt does not
   * name, so the per-id narrowing below would skip it.
   */
  readonly allLinkViews?: boolean;
};

/**
 * Every query family that renders an artifact.
 *
 * One registry, because the defect ISS-9578 fixes is four bulk bars each
 * maintaining their own — a view named by one bar stayed stale after a
 * mutation driven from another.
 */
const ARTIFACT_VIEW_FAMILIES = {
  documents: documentKeys.all,
  // The Documents cards' summary and cost reads (ISS-12600). Nested under
  // `documents`, and named so a write that moves only the cards — a favorite
  // toggle, a custom-field value — reaches them without refetching the lists.
  documentSummaries: documentKeys.summaries(),
  // The team project list carries each project's completionPercentage and
  // empty-population flag with a stale time (ISS-4679).
  projects: projectKeys.all,
  // The project board renders its rows from the tree query, not from
  // `documentKeys.list` (FEA-2940).
  projectTree: projectTreeKeys.all,
  branchLists: branchRowQueryKeys.lists,
  branchDetails: branchRowQueryKeys.details,
  branchPageData: branchRowQueryKeys.pageData,
  // Session rows project the same tag and favorite joins and read them from
  // the CACHED row (ISS-8712). The unscoped prefixes are deliberate: they
  // match every data-source scope, desktop-local and cloud alike.
  sessionLists: agentSessionKeys.lists(),
  sessionPageData: agentSessionKeys.pageDataRoot(),
  sessionDetails: agentSessionKeys.details(),
  // The Sessions summary/count reads. They aggregate over the same population
  // the lists above show, so a bulk change that adds or removes a row moves
  // these numbers — and a stale count renders a confident wrong value rather
  // than a gap.
  sessionAnalytics: agentSessionKeys.analyticsRoot(),
  sessionUsage: agentSessionKeys.usages(),
  // The star is rendered from this batched list on both the Documents table
  // and the Sessions list.
  favorites: artifactFavoriteKeys.all,
} as const satisfies Record<string, readonly unknown[]>;

type ArtifactViewFamily = keyof typeof ARTIFACT_VIEW_FAMILIES;

/**
 * Which of those families a TAG write can answer differently afterwards.
 *
 * `AgentSessionQueryFilters` carries no tag facet and neither
 * `AgentSessionAnalytics` nor `AgentSessionUsageSummary` projects one, so
 * neither Sessions aggregate can move when a tag changes — and `analytics` is
 * the long aggregate `useAgentSessionAnalytics` has to cancel in flight
 * (ISS-9741). Favorites are a separate join no tag write touches. Exhaustive
 * over the registry, so a family added above fails `tsc` here rather than
 * silently joining every tag toggle.
 */
const MOVED_BY_TAG_WRITE: Record<ArtifactViewFamily, boolean> = {
  documents: true,
  // Already refetched under `documents`.
  documentSummaries: false,
  projects: true,
  projectTree: true,
  branchLists: true,
  branchDetails: true,
  branchPageData: true,
  sessionLists: true,
  sessionPageData: true,
  sessionDetails: true,
  sessionAnalytics: false,
  sessionUsage: false,
  favorites: false,
};

/**
 * Invalidate every query family that renders an artifact.
 *
 * Over-refetching is the accepted cost of that convergence:
 * `invalidateQueries` refetches only the families a surface is currently
 * subscribed to, and a needless refetch renders the same value while a missing
 * one renders a confident wrong one.
 */
function invalidateArtifactViewFamilies(queryClient: QueryClient): void {
  invalidateMovedFamilies(queryClient, MOVED_BY_BULK_WRITE);
}

/**
 * Invalidate the families a tag write can move — the same registry narrowed by
 * {@link MOVED_BY_TAG_WRITE}, not a second hand-kept list.
 */
export function invalidateTagWriteViewFamilies(queryClient: QueryClient): void {
  invalidateMovedFamilies(queryClient, MOVED_BY_TAG_WRITE);
}

/** The families a favorite toggle moves: the star list and the cards. */
export function invalidateFavoriteWriteViewFamilies(
  queryClient: QueryClient
): void {
  invalidateMovedFamilies(queryClient, MOVED_BY_FAVORITE_WRITE);
}

/**
 * The families a Document custom-field value write moves beyond the per-entity
 * reads its writer refreshes itself: the cards, whose facet-scoped key does not
 * change when a value does.
 */
export function invalidateDocumentCustomFieldWriteViewFamilies(
  queryClient: QueryClient
): void {
  invalidateMovedFamilies(queryClient, MOVED_BY_DOCUMENT_CUSTOM_FIELD_WRITE);
}

/**
 * Invalidate every view of the artifacts a bulk mutation changed, from that
 * mutation's own receipt.
 *
 * Nothing is invalidated when the receipt names no committed id. R5 (DOC-36)
 * scopes side effects to the committed subset, and R11 makes a batch that
 * commits nothing reachable — refetching on that outcome reports a change the
 * server did not make.
 */
export function invalidateForBulkArtifactMutation(
  queryClient: QueryClient,
  receipt: BulkArtifactReceipt,
  options?: BulkArtifactInvalidationOptions
): void {
  if (receipt.committedIds.length === 0) {
    return;
  }

  invalidateArtifactViewFamilies(queryClient);

  if (options?.allLinkViews) {
    invalidateAllArtifactLinkQueries(queryClient);
    return;
  }

  // Resolved artifact-link views hold their endpoints inline, so the only way
  // to find the ones showing a committed artifact is to match on the id. This
  // is the half of the set the receipt genuinely decides; the roots above are
  // prefixes the client cannot narrow, because a bulk response does not say
  // which projects, branches or sessions the change reached.
  for (const artifactId of receipt.committedIds) {
    invalidateArtifactLinkQueries(queryClient, artifactId);
  }
}

/** A receipt from a response that names the ids it committed. */
export function bulkReceiptFromCommittedIds(
  committedIds: readonly string[]
): BulkArtifactReceipt {
  return { committedIds };
}

function invalidateMovedFamilies(
  queryClient: QueryClient,
  moved: Record<ArtifactViewFamily, boolean>
): void {
  for (const [family, queryKey] of Object.entries(ARTIFACT_VIEW_FAMILIES)) {
    if (moved[family as ArtifactViewFamily]) {
      queryClient.invalidateQueries({ queryKey });
    }
  }
}

/** Every family, once: `documentSummaries` already refetches under `documents`. */
const MOVED_BY_BULK_WRITE: Record<ArtifactViewFamily, boolean> = {
  documents: true,
  documentSummaries: false,
  projects: true,
  projectTree: true,
  branchLists: true,
  branchDetails: true,
  branchPageData: true,
  sessionLists: true,
  sessionPageData: true,
  sessionDetails: true,
  sessionAnalytics: true,
  sessionUsage: true,
  favorites: true,
};

const MOVED_BY_FAVORITE_WRITE: Record<ArtifactViewFamily, boolean> = {
  documents: false,
  documentSummaries: true,
  projects: false,
  // ISS-10472: a star is a server-side FILTER on the My Tasks All tab, so the
  // tree read that drew the page and counted its total is a view the write
  // moves. Unstarring with Favorites on left that page cached — the row and the
  // "of N" both stayed put (tamsinb, PR #9091).
  projectTree: true,
  branchLists: false,
  branchDetails: false,
  branchPageData: false,
  sessionLists: false,
  sessionPageData: false,
  sessionDetails: false,
  sessionAnalytics: false,
  sessionUsage: false,
  favorites: true,
};

const MOVED_BY_DOCUMENT_CUSTOM_FIELD_WRITE: Record<
  ArtifactViewFamily,
  boolean
> = {
  ...MOVED_BY_FAVORITE_WRITE,
  favorites: false,
  // Pinned rather than inherited: the tree entry above is there because a star
  // is a tree FILTER, which a custom-field value is not. Spreading it would
  // widen this set on the back of an unrelated decision.
  projectTree: false,
};
