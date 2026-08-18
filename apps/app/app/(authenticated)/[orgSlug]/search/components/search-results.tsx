"use client";

import {
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
import {
  DOCUMENT_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { SearchEmptyOnRamp } from "@repo/app/search/components/search-empty-onramp";
import { SearchTypeControl } from "@repo/app/search/components/search-type-control";
import { SearchTypeahead } from "@repo/app/search/components/search-typeahead";
import { UnifiedSearchResults } from "@repo/app/search/components/unified-search-results";
import {
  MIN_UNIFIED_QUERY_LENGTH,
  useGlobalSearch,
  useSearchPanelState,
} from "@repo/app/search/hooks/use-search";
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
import { formatDate } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
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

      {showResults ? (
        <>
          {/* The count strip must not assert a result count next to an error —
              a failed query returned no set, so a "0 results" line beside the
              error banner would lie about state. Suppress it while either the
              load error or the inline filter error is active. */}
          {!(isError || filterErrorMessage) && (
            <ResultCountStrip
              hasMore={Boolean(nextCursor)}
              isLoading={isLoading}
              loadedCount={results.length}
              onClear={handleClearSearch}
              query={urlQuery}
            />
          )}
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
        </>
      ) : (
        <SearchEmptyOnRamp
          onRunExample={(example) => {
            setQuery(example);
            commitQuery(example);
          }}
        />
      )}
    </div>
  );
}

/**
 * The thin result-context strip: an honest count (`N`/`N+` while a cursor
 * remains) plus a Clear action, announced to assistive tech via `aria-live` so
 * a screen reader hears the count change on re-query.
 */
function ResultCountStrip({
  query,
  loadedCount,
  hasMore,
  isLoading,
  onClear,
}: Readonly<{
  query: string;
  loadedCount: number;
  hasMore: boolean;
  isLoading: boolean;
  onClear: () => void;
}>) {
  const countLabel = hasMore ? `${loadedCount}+` : String(loadedCount);
  const resultNoun = loadedCount === 1 && !hasMore ? "result" : "results";
  const text = isLoading
    ? `Searching for "${query}"…`
    : `${countLabel} ${resultNoun} for "${query}"`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b pb-2">
      <p className="text-muted-foreground text-sm">{text}</p>
      <span aria-live="polite" className="sr-only">
        {text}
      </span>
      <Button
        aria-label="Clear search"
        onClick={onClear}
        size="sm"
        type="button"
        variant="outline"
      >
        <XIcon className="size-3.5" />
        Clear
      </Button>
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
                <TitleCell href={`/${orgSlug}/issues/${feature.slug}`}>
                  {feature.title}
                </TitleCell>
              </TableCell>
              <TableCell>
                {/* This list holds Features, so status is a IssueStatus (PRD-495). */}
                <IssueStatusBadge status={feature.status as IssueStatus} />
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
                  {project.priority && (
                    <IssuePriorityBadge priority={project.priority} />
                  )}
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
