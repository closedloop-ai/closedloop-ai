"use client";

import { DiagnosticsSurfaceV2 } from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import type { DiagnosticsSource } from "@repo/app/diagnostics/lib/diagnostics-source";
import { DiagnosticsTransportStatus } from "@repo/app/diagnostics/lib/diagnostics-source";
import { HelpSurfaceV2 } from "@repo/app/help/components/help-surface-v2";
import {
  DocsHelpBundleStatus,
  type DocsHelpPageState,
  type DocsHelpSource,
} from "@repo/app/help/lib/docs-help-source";
import { PrototypeShell } from "@repo/app/shell/v2/components/prototype-shell";
import { useCallback, useMemo, useState } from "react";
import { searchDocs, slugifyHeading } from "./docs-search";
import {
  COVERAGE_AXIS_LABELS,
  DEFAULT_DOCS_PATH,
  DIAGNOSTICS_ROUTE_TITLE,
  DOCS_NAV_GROUPS,
  DOCS_PAGES,
  DOCS_SITE_URL,
  WEB_AVAILABLE_SECTIONS,
  WEB_DIAGNOSTICS_DESCRIPTION,
  WEB_DOCS_CORPUS_COPY,
  WEB_PROBE_UNAVAILABLE_MESSAGE,
  WEB_SECTION_UNSERVABLE_REASON,
} from "./mock";

function noop(): void {
  return;
}

/**
 * The Web mock host for ISS-10006's two utility routes: the REAL
 * `DiagnosticsSurfaceV2` and `HelpSurfaceV2`, fed web-shaped fixtures and
 * nothing else. It redraws neither, because the question these routes raise is
 * which sections a browser host offers at all — and the live tab strip, not a
 * picture of one, is what answers it.
 *
 * Both mounts sit in ONE component on purpose: `production-bound-prototype-route.ts`
 * refuses any rendered tag that is not an allowlisted portable surface, and a
 * local `<WebHelp />` wrapper is exactly such a tag. The shape a production-bound
 * route is allowed is a mock host, so this is one.
 */
const WebUtilityRoutesPrototypePage = () => {
  // Seeded rather than idle: HelpSurfaceV2 renders nothing for `idle`, and a
  // blank reader pane is the opposite of what this preview is showing.
  const [selectedPath, setSelectedPath] = useState<string | null>(
    DEFAULT_DOCS_PATH
  );
  const [pendingHeadingSlug, setPendingHeadingSlug] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");

  const selectPage = useCallback((path: string, headingSlug?: string) => {
    setSelectedPath(path);
    setPendingHeadingSlug(headingSlug ?? null);
  }, []);

  const onHeadingHandled = useCallback(() => setPendingHeadingSlug(null), []);

  const searchHits = useMemo(() => searchDocs(searchQuery), [searchQuery]);

  const page: DocsHelpPageState = useMemo(() => {
    if (selectedPath === null) {
      return { kind: "idle" };
    }
    const found = DOCS_PAGES.find((entry) => entry.path === selectedPath);
    return found === undefined
      ? { kind: "missing" }
      : { kind: "found", page: found };
  }, [selectedPath]);

  // `unservableReason` is what the production mount (PR #7757) added to
  // express the 2026-09-22 ruling: every section body names why it is not
  // served here, and the surface drops Refresh on its own, so `refresh` is a
  // required no-op nothing can reach (whitlockk review: never simulate a probe).
  const diagnostics: DiagnosticsSource = {
    autoRefresh: null,
    availableSections: WEB_AVAILABLE_SECTIONS,
    errorMessage: WEB_PROBE_UNAVAILABLE_MESSAGE,
    onSectionChange: noop,
    payload: null,
    refresh: { busy: false, run: noop },
    settledSections: [],
    status: DiagnosticsTransportStatus.Unavailable,
    unservableReason: WEB_SECTION_UNSERVABLE_REASON,
  };

  const help: DocsHelpSource = {
    bundleStatus: DocsHelpBundleStatus.Ready,
    docsSiteUrl: DOCS_SITE_URL,
    isSearching: false,
    navGroups: DOCS_NAV_GROUPS,
    onHeadingHandled,
    onSearchQueryChange: setSearchQuery,
    page,
    pendingHeadingSlug,
    searchFailed: false,
    searchHits,
    searchQuery,
    selectPage,
    selectedPath,
  };

  return (
    <PrototypeShell
      activePath="/settings"
      breadcrumbs={[
        { label: "Web utility routes" },
        { isCurrent: true, label: "Diagnostics & Help" },
      ]}
    >
      <DiagnosticsSurfaceV2
        coverageAxisLabels={COVERAGE_AXIS_LABELS}
        description={WEB_DIAGNOSTICS_DESCRIPTION}
        logs={null}
        source={diagnostics}
        title={DIAGNOSTICS_ROUTE_TITLE}
      />
      <HelpSurfaceV2
        corpusCopy={WEB_DOCS_CORPUS_COPY}
        slugifyHeading={slugifyHeading}
        source={help}
      />
    </PrototypeShell>
  );
};

export default WebUtilityRoutesPrototypePage;
