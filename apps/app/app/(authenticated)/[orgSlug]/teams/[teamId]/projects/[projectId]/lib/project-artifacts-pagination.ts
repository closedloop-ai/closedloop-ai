import {
  PROJECT_TREE_MAX_ROOT_LIMIT,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { treeHasActiveGeneration } from "@repo/app/documents/lib/artifact-row-adapter";
import type { useProjectTreeWithDetails } from "@repo/app/projects/hooks/use-project-tree";

/**
 * Copy and request-shaping helpers for the project detail page's paginated
 * artifact tabs
 * (ISS-5307). Pure functions in their own module so the page component stays an
 * orchestrator and the wording can be asserted without mounting the page.
 */

/**
 * The noun the range readout counts, per tab.
 *
 * Each tab renders a different population, so one generic word would make the
 * footer describe the wrong thing: "1–25 of 240 artifacts" under the Plans tab
 * reads as a project-wide total when it is the plan count. The map is exhaustive
 * over `FilterCategory` — a new tab fails typecheck here rather than silently
 * inheriting a word that does not describe it.
 *
 * `all` says **top-level** artifacts, and the word is load-bearing. That tab
 * pages ROOT GROUPS, and each counted root drags its whole nested subtree onto
 * the page with it — so a page of 25 can put 80 rows on screen, and a bare
 * "of 240 artifacts" would be a number the visible table openly contradicts.
 * My Tasks names the same unit "top-level tasks" for the same reason; the two
 * surfaces page the same tree and must not describe it differently.
 */
const PAGE_NOUNS: Record<FilterCategory, string> = {
  all: "top-level artifacts",
  documents: "PRDs",
  features: "issues",
  plans: "plans",
  branches: "branches",
};

export function resolveProjectArtifactsPageNoun(
  filterCategory: FilterCategory
): string {
  return PAGE_NOUNS[filterCategory];
}

/**
 * The footer's second line when the SERVER bounded the read.
 *
 * The range readout above it counts rows the browser actually holds. When the
 * project has more top-level artifacts than one bounded read returns, that
 * count is a count of the prefix, not of the project. The readout marks that by
 * rendering its total as a floor ("500+"); this note says what the floor was
 * counted from. The two ship together deliberately — My Tasks
 * (`resolveMyTasksTruncation`) records that a marker with no note is cryptic,
 * and a note with no marker leaves a confident wrong number on screen.
 *
 * ONE number, not three. The line above already carries three, and stacking
 * "of at least 12,384" under it is the density ISS-4682 walked My Tasks back
 * from — the caveat stops being read at exactly the moment it matters.
 *
 * Returns `null` on a complete read, which is the overwhelmingly common case:
 * an untruncated response carries no `truncation` at all, and a page that
 * showed a caveat anyway would train people to ignore it.
 */
export function resolveProjectArtifactsTruncationNote(
  treeData: Pick<ProjectTreeResponse, "truncation"> | null | undefined
): string | null {
  const included = resolveTruncationAnchorCount(treeData);
  if (included === null) {
    return null;
  }
  return `Counted from the first ${included} top-level artifacts in this project.`;
}

/**
 * The same caveat, worded for a tab that ended up with NO rows.
 *
 * The bounded read's caveat used to live only inside the footer, and the footer
 * only renders when the tab has rows — so filtering a truncated project down to
 * zero matches dropped the caveat at the one moment it decides what the screen
 * MEANS. The user reads "no PRDs match this filter" and concludes the project
 * has none, when the truth is that none were found in the prefix we loaded.
 *
 * Deliberately not the footer's sentence: "Counted from the first 500" explains
 * a number that is no longer on screen. This one explains an absence, which is
 * the only claim the empty tab is making. Both derive their figure from
 * {@link resolveTruncationAnchorCount}, so the two wordings cannot drift onto
 * different numbers.
 */
export function resolveProjectArtifactsEmptyTruncationNote(
  treeData: Pick<ProjectTreeResponse, "truncation"> | null | undefined
): string | null {
  const included = resolveTruncationAnchorCount(treeData);
  if (included === null) {
    return null;
  }
  return `No matches in the first ${included} top-level artifacts in this project. The rest were not loaded.`;
}

/**
 * The formatted count of top-level artifacts a bounded read actually returned,
 * or `null` when the read was complete. The single source of the figure both
 * truncation notes quote.
 */
function resolveTruncationAnchorCount(
  treeData: Pick<ProjectTreeResponse, "truncation"> | null | undefined
): string | null {
  const truncation = treeData?.truncation;
  if (!truncation || truncation.reasons.length === 0) {
    return null;
  }
  return truncation.anchorsIncluded.toLocaleString();
}

/**
 * Query options for the project's artifact tree read (ISS-5307).
 *
 * `filters` is present only when pagination is on, so a viewer with the flag
 * off issues the byte-identical unbounded request they issued before this
 * ticket — including the same cache key, since `limit` participates in it.
 *
 * `isReady` is the flag-resolution gate, and it is the reason this builder
 * takes two booleans instead of one (wongk). The flag decides this request's
 * PARAMS, and PostHog resolves asynchronously, so acting on an unresolved flag
 * would send the unbounded shape and then refetch bounded the moment it landed
 * — an enabled viewer paying the exact cost the bound removes, at first paint.
 * Holding the query until the flag answers makes it ONE request.
 *
 * It is passed through as the query's `enabled`, which REPLACES the hook's own
 * `!!projectId` guard rather than adding to it — so that guard is re-applied
 * here instead of at the call site.
 */
export function buildProjectTreeReadOptions(
  isPaginationEnabled: boolean,
  isReady: boolean,
  projectId: string
): Parameters<typeof useProjectTreeWithDetails>[1] {
  return {
    enabled: isReady && Boolean(projectId),
    ...(isPaginationEnabled && {
      filters: { limit: PROJECT_TREE_MAX_ROOT_LIMIT },
    }),
    refetchInterval: (query) =>
      treeHasActiveGeneration(query.state.data) ? 5000 : false,
  };
}

/**
 * Whether the artifact table should still be showing its loading state.
 *
 * A TanStack query held on `enabled: false` reports `isLoading: false`, so the
 * flag gate above has to be folded in explicitly. Without it the table would
 * render its "this project has no artifacts" empty state for the moment the
 * flag is still resolving — a screen asserting something nobody has checked
 * yet, which is the lie the truncation note and the true-total readout exist to
 * keep off this surface.
 */
export function isProjectArtifactTreeLoading(
  isTreeQueryLoading: boolean,
  isPaginationFlagReady: boolean
): boolean {
  return isTreeQueryLoading || !isPaginationFlagReady;
}
