"use client";

import type { Priority } from "@repo/api/src/types/common";
import {
  buildScopedDocumentPath,
  DOCUMENT_ROUTE_PREFIX,
  type DocumentStatus,
  DocumentType,
  getRoutePrefixForType,
  type IssueStatus,
} from "@repo/api/src/types/document";
import type {
  DocumentSearchResult,
  ProjectSearchResult,
} from "@repo/api/src/types/search";
import {
  isSupportedSearchType,
  type SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { priorityDisplayFallback } from "@repo/app/documents/lib/priority-display-fallback";
import {
  DOCUMENT_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { SearchEmptyOnRamp } from "@repo/app/search/components/search-empty-onramp";
import { SearchResultCountStrip } from "@repo/app/search/components/search-result-count-strip";
import { SearchSurfaceV2 } from "@repo/app/search/components/search-surface-v2";
import { SearchSurfaceModeKind } from "@repo/app/search/components/search-surface-v2-props";
import { SearchTypeControl } from "@repo/app/search/components/search-type-control";
import { SearchTypeahead } from "@repo/app/search/components/search-typeahead";
import { UnifiedSearchResults } from "@repo/app/search/components/unified-search-results";
import {
  MIN_UNIFIED_QUERY_LENGTH,
  useGlobalSearch,
  useSearchPanelState,
} from "@repo/app/search/hooks/use-search";
import { searchHitsToSurfaceResults } from "@repo/app/search/lib/search-surface-model";
import {
  activeTypeKinds,
  addTypeToken,
  toggleTypeToken,
} from "@repo/app/search/lib/search-type-tokens";
import {
  DocumentStatusBadge,
  IssuePriorityBadge,
  IssueStatusBadge,
} from "@repo/app/shared/components/status-badge";
import {
  useFeatureFlagEnabled,
  useFeatureFlagEnabledOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { formatDate } from "@repo/app/shared/lib/date-utils";
import { PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Loader2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";

export function SearchResults() {
  const searchParams = useSearchParamsValue();
  const tagId = searchParams.get("tagId") ?? "";

  // TRANSITIONAL DIVERGENCE (FEA-3873): tag search still renders the legacy
  // grouped sections-with-badges table, while free-text search renders the new
  // unified FTS flat list with type chips. This is intentional for the FTS
  // rollout, not the target state, the two treatments should converge on the
  // single unified result UI once tag search is migrated onto the projection.
  // Do not add a third treatment here; fold tag search into the unified list.
  if (tagId) {
    return <TagSearchResults tagId={tagId} />;
  }

  return <UnifiedSearchPanel />;
}

/**
 * FEA-4134 — the redesigned `/search` results surface. The editable query bar
 * ({@link SearchTypeahead}, reusing the FEA-3930/4011 intellisense) is the
 * single source of truth for the whole query, INCLUDING the entity-kind filter:
 * the mouse-first {@link SearchTypeControl} writes inline `type:` tokens into
 * the same string (so the two never disagree), which the parser lifts into the
 * corpus predicate. The URL `q` param holds the full query; a submit syncs it.
 * Faithful to the FEA-4031 prototype: an empty on-ramp, loading skeletons, a
 * load-error retry, an inline filter-error banner, a no-results state, and an
 * honest result-count strip.
 */
function UnifiedSearchPanel() {
  const orgSlug = useOrgSlug();
  // ONE read, HERE, choosing between two whole result bodies. Neither branch
  // knows the gate exists. The same PostHog key gates the Desktop command
  // palette, which resolves the signed-in account's assignment from the same
  // key space, so there is no second key and no Labs toggle beside it.
  const portableSearchSurface = useFeatureFlagEnabled(
    PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY
  );
  const navigation = useNavigation();
  const searchParams = useSearchParamsValue();
  // BACKWARD COMPAT (FEA-4134): the previous `/search` UI expressed the entity
  // filter as repeated `?types=<kind>` params. A bookmark, shared link, or
  // history entry from that UI must not silently lose its filter, so fold any
  // legacy `types=` into inline `type:` tokens on the effective query.
  const rawUrlQuery = searchParams.get("q") ?? "";
  const legacyTypes = searchParams.getAll("types");
  const urlQuery = foldLegacyTypes(rawUrlQuery, legacyTypes);

  // Local editable query, seeded from the URL. The bar edits this live; a submit
  // (Enter / example / Type-control toggle) commits it back to the URL `q` so
  // the query is shareable and survives a refresh. Keyed by the URL value so a
  // back/forward navigation reseeds the bar.
  const [query, setQuery] = useState(urlQuery);
  // Reseed the editable bar when the URL query changes from OUTSIDE this panel
  // (a back/forward navigation, or the sidebar search landing here) without
  // clobbering the value the panel itself just committed. Tracking the last URL
  // value it reflected distinguishes an external change from its own commit.
  const lastUrlQuery = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== lastUrlQuery.current) {
      lastUrlQuery.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  // Normalize a legacy `?types=` URL to the folded `type:`-token `q` form once,
  // so the shareable URL, the query key, and the bar all speak the new grammar.
  const hasLegacyTypes = legacyTypes.length > 0;
  useEffect(() => {
    if (!hasLegacyTypes) {
      return;
    }
    lastUrlQuery.current = urlQuery;
    const path =
      urlQuery.length > 0
        ? `/${orgSlug}/search?${new URLSearchParams({ q: urlQuery }).toString()}`
        : `/${orgSlug}/search`;
    navigation.replace(path, { scroll: false });
  }, [hasLegacyTypes, urlQuery, orgSlug, navigation]);

  const activeKinds = activeTypeKinds(query);

  // Runs the unified query off the COMMITTED URL query (not every keystroke), so
  // typing in the bar does not fire a request per character — the FTS query
  // reruns on submit. Shares the 400-filter-error classification with the mobile
  // sheet via useSearchPanelState.
  const {
    results,
    isLoading,
    isRetrying,
    isError,
    filterErrorMessage,
    nextCursor,
    refetch,
  } = useSearchPanelState({ query: urlQuery });

  const commitQuery = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      // Record the value we are about to push so the reseed effect recognizes
      // this URL change as our own commit, not an external back/forward, and
      // does not clobber a newer in-flight edit once the async URL update lands.
      lastUrlQuery.current = trimmed;
      if (trimmed.length === 0) {
        setQuery("");
        navigation.replace(`/${orgSlug}/search`, { scroll: false });
        return;
      }
      const params = new URLSearchParams({ q: trimmed });
      navigation.replace(`/${orgSlug}/search?${params.toString()}`, {
        scroll: false,
      });
    },
    [navigation, orgSlug]
  );

  // The Type control writes a `type:` token into the query AND commits it, so a
  // toggle immediately reruns the filtered query (the bar stays the SSOT).
  const handleToggleKind = (kind: SearchEntityType) => {
    const next = toggleTypeToken(query, kind);
    setQuery(next);
    commitQuery(next);
  };

  // Clear lands the empty on-ramp (the right home for a cleared search), the
  // same place the query bar's own clear goes, so the two clears on this screen
  // do ONE thing. commitQuery("") empties the bar and drops `q` from the URL.
  const handleClearSearch = () => {
    setQuery("");
    commitQuery("");
  };

  const showResults = urlQuery.trim().length >= MIN_UNIFIED_QUERY_LENGTH;

  // Runs an on-ramp example: seeds the bar and commits it, exactly as the
  // pre-ISS-9414 inline handler did. Named because both branches wire it now.
  const runExample = (example: string) => {
    setQuery(example);
    commitQuery(example);
  };

  // The pre-ISS-9414 body, kept whole behind the flag. Bound to a name rather
  // than nested in the branch below because the two questions — which surface,
  // and has the query run — are separate, and only the legacy branch still asks
  // the second one for itself.
  const legacyResultsBody = showResults ? (
    <UnifiedSearchResults
      activeTypes={activeKinds}
      filterErrorMessage={filterErrorMessage}
      hideTypeFacets
      isError={isError}
      isLoading={isLoading}
      onRetry={refetch}
      // Kind filtering is owned by the query bar's `type:` tokens, so the
      // in-list facet toggle routes through the same token writer.
      onToggleType={handleToggleKind}
      results={results}
    />
  ) : (
    <SearchEmptyOnRamp onRunExample={runExample} />
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="sr-only">Search results</h1>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <SearchTypeahead
            nativeAction={`/${orgSlug}/search`}
            nativeInputName="q"
            nativeMethod="get"
            onClear={() => commitQuery("")}
            onSubmit={commitQuery}
            onValueChange={setQuery}
            showClear={query.length > 0}
            value={query}
          />
        </div>
        <SearchTypeControl
          activeKinds={activeKinds}
          onToggleKind={handleToggleKind}
        />
      </div>

      {/* The count strip must not assert a result count next to an error —
          a failed query returned no set, so a "0 results" line beside the
          error banner would lie about state. Suppress it while either the
          load error or the inline filter error is active. */}
      {showResults && !(isError || filterErrorMessage) && (
        <SearchResultCountStrip
          hasMore={Boolean(nextCursor)}
          isLoading={isLoading}
          loadedCount={results.length}
          onClear={handleClearSearch}
          query={urlQuery}
        />
      )}

      {portableSearchSurface ? (
        <SearchSurfaceV2
          mode={{
            kind: SearchSurfaceModeKind.Page,
            onRunExample: runExample,
          }}
          onRetry={refetch}
          query={urlQuery}
          read={{
            // `showResults` IS "the query ran": the hook fires at the same
            // 2-char floor, so below it nothing was asked and the surface must
            // not claim an empty corpus.
            hasRun: showResults,
            // A retry in flight is a load, not the failure it is fixing: the
            // ladder puts Loading above Unavailable, so this is what moves the
            // surface off the settled error while the refetch runs.
            isLoading: isLoading || isRetrying,
            isUnavailable: isError,
            // A malformed inline filter is a 400 whose body is safe to show, so
            // the surface names the query as the thing that failed and offers
            // no retry. Any other failure has no such sentence and gets one.
            unavailableReason: filterErrorMessage ?? null,
            resultCount: results.length,
          }}
          results={searchHitsToSurfaceResults(results)}
        />
      ) : (
        legacyResultsBody
      )}
    </div>
  );
}

function TagSearchResults({ tagId }: Readonly<{ tagId: string }>) {
  const orgSlug = useOrgSlug();
  const navigation = useNavigation();

  const { data, isLoading } = useGlobalSearch({ tagId });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalResults = data ? data.documents.length + data.projects.length : 0;

  const notFeatures = data?.documents.filter(
    (d) => d.type !== DocumentType.Feature
  );
  const features = data?.documents.filter(
    (d) => d.type === DocumentType.Feature
  );

  const handleClearSearch = () => {
    navigation.replace(`/${orgSlug}/my-tasks`, { scroll: false });
  };

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">
          {`${totalResults} result${totalResults === 1 ? "" : "s"} tagged with "${data?.tagName ?? ""}"`}
        </p>
        <Button
          aria-label="Clear search"
          onClick={handleClearSearch}
          size="sm"
          type="button"
          variant="outline"
        >
          <XIcon className="size-3.5" />
          Clear
        </Button>
      </div>

      {totalResults === 0 && (
        <div className="py-8 text-center text-muted-foreground">
          No documents found with this tag.
        </div>
      )}

      {!!notFeatures?.length && <ArtifactsSection artifacts={notFeatures} />}

      {!!features?.length && <FeaturesSection features={features} />}

      {!!data?.projects.length && <ProjectsSection projects={data.projects} />}
    </>
  );
}

function SectionHeader({
  title,
  count,
}: Readonly<{ title: string; count: number }>) {
  return (
    <h2 className="mt-6 mb-2 font-semibold text-lg">
      {title}{" "}
      <span className="font-normal text-muted-foreground text-sm">
        ({count})
      </span>
    </h2>
  );
}

function TitleCell({
  href,
  children,
}: Readonly<{ href: string | null; children: React.ReactNode }>) {
  if (href) {
    return (
      <Link className="font-medium text-foreground hover:underline" href={href}>
        {children}
      </Link>
    );
  }
  return <span className="font-medium">{children}</span>;
}

function ArtifactsSection({
  artifacts,
}: Readonly<{ artifacts: DocumentSearchResult[] }>) {
  const orgSlug = useOrgSlug();
  return (
    <section>
      <SectionHeader count={artifacts.length} title="Artifacts" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => {
            const routePrefix = getRoutePrefixForType(artifact.type);
            const href = routePrefix
              ? `/${orgSlug}/${routePrefix}/${artifact.slug}`
              : null;

            return (
              <TableRow key={artifact.id}>
                <TableCell>
                  <TitleCell href={href}>{artifact.title}</TitleCell>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {DOCUMENT_TYPE_LABELS[artifact.type as DocumentType] ??
                    artifact.type}
                </TableCell>
                <TableCell>
                  {/* This list holds non-Feature documents, so status is a DocumentStatus (PRD-495). */}
                  <DocumentStatusBadge
                    artifactId={artifact.id}
                    status={artifact.status as DocumentStatus}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {artifact.projectName ?? "-"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(artifact.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function FeaturesSection({
  features,
}: Readonly<{ features: DocumentSearchResult[] }>) {
  const orgSlug = useOrgSlug();
  return (
    <section>
      <SectionHeader count={features.length} title="Issues" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {features.map((feature) => (
            <TableRow key={feature.id}>
              <TableCell>
                <TitleCell
                  href={buildScopedDocumentPath(
                    DOCUMENT_ROUTE_PREFIX,
                    feature.slug,
                    orgSlug
                  )}
                >
                  {feature.title}
                </TitleCell>
              </TableCell>
              <TableCell>
                {/* This list holds Features, so status is a IssueStatus (PRD-495). */}
                <IssueStatusBadge
                  artifactId={feature.id}
                  status={feature.status as IssueStatus}
                />
              </TableCell>
              <TableCell>
                {feature.priority && (
                  <IssuePriorityBadge priority={feature.priority} />
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {feature.projectName ?? "-"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(feature.updatedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function ProjectsSection({
  projects,
}: Readonly<{ projects: ProjectSearchResult[] }>) {
  const orgSlug = useOrgSlug();
  // ISS-9441: flag OFF folds an unset project priority to Medium, which is what
  // this table showed before a project could hold none.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  return (
    <section>
      <SectionHeader count={projects.length} title="Projects" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Team</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => {
            const href = project.teamId
              ? `/${orgSlug}/teams/${project.teamId}/projects/${project.id}`
              : null;

            return (
              <TableRow key={project.id}>
                <TableCell>
                  <TitleCell href={href}>{project.name}</TitleCell>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {PROJECT_STATUS_LABELS[project.status] ?? project.status}
                </TableCell>
                <TableCell>
                  <ProjectPriorityCell
                    priority={
                      unsetPriorityEnabled
                        ? project.priority
                        : priorityDisplayFallback(project).priority
                    }
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {project.teamName ?? "-"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(project.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

/**
 * Fold legacy `?types=<kind>` params (the previous UI's entity-filter contract)
 * into the query's inline `type:` tokens so an old bookmark or shared link keeps
 * its filter. Unknown/invalid legacy values are ignored, matching the parser,
 * and `addTypeToken` skips a kind already present in `q`, so re-folding is
 * idempotent and never double-adds a token.
 */
function foldLegacyTypes(
  query: string,
  legacyTypes: readonly string[]
): string {
  let next = query;
  for (const value of legacyTypes) {
    const kind = value.toLowerCase();
    if (isSupportedSearchType(kind)) {
      next = addTypeToken(next, kind);
    }
  }
  return next;
}

/**
 * An unset project priority is named beside the empty-value mark, as the project
 * overview names it, so the cell is not mistaken for a value that failed to load.
 */
function ProjectPriorityCell({
  priority,
}: Readonly<{ priority: Priority | null }>) {
  if (priority === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden="true">
          <GridEmptyValue />
        </span>
        {PRIORITY_LABEL_NONE}
      </span>
    );
  }
  return <IssuePriorityBadge priority={priority} />;
}
