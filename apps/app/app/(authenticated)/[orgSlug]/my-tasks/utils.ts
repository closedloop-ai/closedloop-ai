import type { BranchRow } from "@repo/api/src/types/branch";
import {
  type ArtifactStatus,
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  DocumentListRecency,
  DocumentStatus,
  type DocumentWithProject,
  type FindDocumentsOptions,
  IssueStatus,
} from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { matchesFilter } from "@repo/app/documents/lib/document-filter";
import { isNavigableDocument } from "@repo/app/documents/lib/document-navigation";
import type { MyTasksArtifactFilters } from "./types";

type DocumentRowItemOnly = Extract<DocumentRowItem, { kind: "document" }>;

export const EMPTY_FILTERS: MyTasksArtifactFilters = {
  priorities: [],
  projectIds: [],
  statuses: [],
};

/**
 * Unified My Tasks columns (PRD-495). The board mixes Documents and Features,
 * which carry disjoint status vocabularies, so each column groups the
 * equivalent statuses from both. Drag-to-set-status resolves the per-type
 * target via `columnTargetStatus` in my-tasks-kanban.tsx.
 */
export const DISPLAY_GROUPS: {
  key: string;
  label: string;
  statuses: ArtifactStatus[];
}[] = [
  {
    key: "backlog",
    label: "Backlog",
    statuses: [DocumentStatus.Draft, IssueStatus.Triage, IssueStatus.Backlog],
  },
  { key: "todo", label: "To Do", statuses: [IssueStatus.Todo] },
  {
    key: "in_progress",
    label: "In Progress",
    statuses: [IssueStatus.InProgress],
  },
  {
    key: "in_review",
    label: "In Review",
    statuses: [DocumentStatus.InReview],
  },
  {
    key: "blocked",
    label: "Blocked / Changes",
    statuses: [DocumentStatus.ChangesRequested, IssueStatus.Blocked],
  },
  { key: "approved", label: "Approved", statuses: [DocumentStatus.Approved] },
  { key: "executed", label: "Executed", statuses: [DocumentStatus.Executed] },
  { key: "done", label: "Done", statuses: [IssueStatus.Done] },
  {
    key: "closed",
    label: "Closed",
    statuses: [DocumentStatus.Obsolete, IssueStatus.Canceled],
  },
];

/**
 * Build API query params for the My Tasks assigned-artifact read. Returns
 * artifacts of any document type (PRDs, Plans, Features) assigned to the given
 * user. Client-side filtering is applied via `applyClientFilters`.
 *
 * ISS-4576 makes this a REAL server page. FEA-4373 bounded the read; ISS-4466
 * paged the render on top of that bound — but a render-layer page cannot make
 * the fetch smaller, and it cannot tell the user how many rows the bound left
 * behind, so the board's "of N" footer silently capped at the fetch size. Both
 * views now pass `limit` + `offset` and read the paged envelope
 * (`includeTotal`), whose server-side `total` is the count the footer states.
 *
 * The two views want different windows and that is deliberate:
 * - the card board renders one card per row, so it takes one screen-sized page;
 * - the list view merges the documents stream with branch/session rows in the
 *   browser, so it needs the widest window the endpoint will serve
 *   ({@link DOCUMENT_LIST_MAX_LIMIT}) and reports the residue honestly through
 *   the envelope's `hasMore`.
 *
 * `offset` is clamped to [0, {@link DOCUMENT_LIST_MAX_OFFSET}] and `limit` to
 * [1, {@link DOCUMENT_LIST_MAX_LIMIT}] — the same window the route validator
 * accepts. `Math.min` alone would let a negative page produce a window the
 * server rejects; capping the offset ceiling keeps a card page past the API's
 * offset limit from being sent as a 400-triggering request (the card bounds
 * hook stops advertising those pages, but this floor makes the contract
 * self-consistent rather than trusting the caller — codex P2).
 */
export function buildArtifactListParams(
  assigneeId: string | null,
  page: { limit: number; offset: number },
  recencyWindowEnabled = false,
  windowRemoved = false
): FindDocumentsOptions {
  return {
    assigneeId: assigneeId ?? undefined,
    limit: Math.max(1, Math.min(page.limit, DOCUMENT_LIST_MAX_LIMIT)),
    offset: Math.max(0, Math.min(page.offset, DOCUMENT_LIST_MAX_OFFSET)),
    // FEA-1626, gated by MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY. Narrowing is
    // opt-IN on the wire: omitting both params is the legacy full-history read,
    // so the flag-off request is byte-identical to the one this board sends
    // today — and stays valid against an API that has not deployed the new
    // params yet. (The original polarity defaulted the window server-side and
    // sent `recencyDays=all` to escape it, which broke in both deploy orders:
    // app-first hit the old strict validator's 400, api-first windowed the old
    // app before its flag existed. wongk review.)
    //
    // With the flag ON the board asks for the window explicitly — and asks for
    // BOTH dimensions, not just recency, so the perceivable change lands as one
    // gated unit. `recencyDays: All` is what the removable "Last 90 days" chip
    // sends when the user drops the window: an explicit "no window" rather than
    // a silently absent param, so the request states the user's choice.
    ...resolveRecencyParams(recencyWindowEnabled, windowRemoved),
  };
}

/**
 * My Tasks trees need every project where the user has assigned artifacts or
 * wrote branches. Branch project IDs come from the server-scoped Branches read,
 * so the page avoids an unbounded all-project tree fanout.
 */
export function collectMyTasksTreeProjectIds(
  assignedArtifacts: readonly Pick<DocumentWithProject, "projectId">[],
  contributedBranches: readonly Pick<BranchRow, "projectId">[]
): string[] {
  const ids = new Set<string>();
  for (const artifact of assignedArtifacts) {
    if (artifact.projectId) {
      ids.add(artifact.projectId);
    }
  }
  for (const branch of contributedBranches) {
    if (branch.projectId) {
      ids.add(branch.projectId);
    }
  }
  return Array.from(ids);
}

/**
 * Apply all selected filters client-side.
 */
export function applyClientFilters(
  artifacts: DocumentWithProject[],
  filters: MyTasksArtifactFilters
): DocumentWithProject[] {
  return artifacts.filter((artifact) => {
    if (
      filters.projectIds.length > 0 &&
      !(artifact.projectId && filters.projectIds.includes(artifact.projectId))
    ) {
      return false;
    }
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(artifact.status)
    ) {
      return false;
    }
    if (
      filters.priorities.length > 0 &&
      !filters.priorities.includes(artifact.priority)
    ) {
      return false;
    }
    return true;
  });
}

export function hasActiveFilters(filters: MyTasksArtifactFilters): boolean {
  return (
    filters.projectIds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.priorities.length > 0
  );
}

/**
 * Derive the navigable document rows shown in the My Tasks card (kanban) view
 * (FEA-4373). Applies the same client-side search + facet filtering the list
 * view uses, then narrows to navigable documents. Extracted from the page so
 * the filtering branches live in one testable helper instead of inflating the
 * page component's cognitive complexity.
 */
export function selectKanbanArtifacts(input: {
  rootItems: DocumentRowItem[];
  filterText: string;
  isAnyFilterActive: boolean;
  applyFilters: (items: DocumentRowItemOnly[]) => DocumentRowItem[];
}): DocumentRowData[] {
  const docItems = input.rootItems.filter(isDocumentRowItem);
  const searched = input.filterText.trim()
    ? docItems.filter((item) => matchesFilter(item.data, input.filterText))
    : docItems;
  const filtered = input.isAnyFilterActive
    ? input.applyFilters(searched).filter(isDocumentRowItem)
    : searched;
  return filtered
    .map((item) => item.data)
    .filter((doc) => isNavigableDocument(doc));
}

/**
 * The `recencyDays` / `includeArchivedProjects` slice of the board's list
 * request (FEA-1626) — the ONE place the three reachable states are decided, so
 * the request, the chip, and the empty state cannot disagree about which window
 * is in force.
 *
 * - flag off → `{}`. Omission is the legacy full-history read; the request is
 *   identical to today's and valid against an API that predates these params.
 * - flag on, window kept → the explicit narrowing the flag exists to ship.
 * - flag on, window removed by the user → an explicit
 *   {@link DocumentListRecency.All} plus `includeArchivedProjects: true`. Same
 *   result set as the flag-off request, but stated on the wire, because it is a
 *   choice the user made rather than an absent capability.
 */
export function resolveRecencyParams(
  recencyWindowEnabled: boolean,
  windowRemoved: boolean
): Pick<FindDocumentsOptions, "recencyDays" | "includeArchivedProjects"> {
  if (!recencyWindowEnabled) {
    return {};
  }
  if (windowRemoved) {
    return {
      recencyDays: DocumentListRecency.All,
      includeArchivedProjects: true,
    };
  }
  return {
    recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
    includeArchivedProjects: false,
  };
}
