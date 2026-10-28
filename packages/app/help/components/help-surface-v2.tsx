"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { BookOpenIcon } from "lucide-react";
import { readNavGroups, readReaderPage } from "../lib/docs-help-payload-guard";
import { DocsHelpBundleStatus } from "../lib/docs-help-source";
import {
  HELP_SURFACE_V2_TEST_ID,
  HELP_SURFACE_V2_UNAVAILABLE_TEST_ID,
} from "../lib/docs-help-test-ids";
import { HELP_NAV_PANE_CHROME, HelpNavPane } from "./help-nav-pane";
import {
  HelpReader,
  HelpReaderLoading,
  HelpReaderMalformed,
  HelpReaderMissing,
  HelpReaderUnavailable,
} from "./help-reader";
import type { HelpSurfaceV2Props } from "./help-surface-v2-props";
import { ViewOnlineAction } from "./help-view-online-action";

/**
 * Master Help, complete (ISS-10005, PRD-730 `wave-fs-3-desktop-to-web`).
 *
 * Owns the navigation, the two-pane layout, search within the docs, the
 * loading / unavailable / not-found / malformed ladder and its own action
 * feedback. The host owns the TRANSPORT: on desktop, read-only IPC over a docs
 * snapshot shipped inside the app — the OS/local-runtime bridge PRD-730 leaves
 * with the shell. No docs index is declared here; the host loads PRD-555's.
 *
 * Closed by default behind ONE PostHog key, read once at each host's mount site.
 * This surface does not know that gate exists.
 */
export function HelpSurfaceV2({
  corpusCopy,
  source,
  slugifyHeading,
}: HelpSurfaceV2Props) {
  const { docsSiteUrl } = source;

  if (source.bundleStatus === DocsHelpBundleStatus.Loading) {
    return (
      <div
        aria-busy
        className="flex h-full min-h-0 w-full"
        data-testid={HELP_SURFACE_V2_TEST_ID}
      >
        <HelpSurfaceNavSkeleton />
        <HelpReaderLoading />
      </div>
    );
  }

  if (source.bundleStatus === DocsHelpBundleStatus.Unavailable) {
    return (
      <div
        className="flex h-full items-center justify-center p-6"
        data-testid={HELP_SURFACE_V2_TEST_ID}
      >
        <div data-testid={HELP_SURFACE_V2_UNAVAILABLE_TEST_ID}>
          <HelpBundleUnavailable
            detail={corpusCopy.corpusUnavailableDetail}
            docsSiteUrl={docsSiteUrl}
            title={corpusCopy.corpusUnavailableTitle}
          />
        </div>
      </div>
    );
  }

  // AC2: the tree is READ, never believed. What was refused travels with what
  // survived — a tree shortened by a refusal is `Partial`, and rendering it as
  // `Ready` tells the reader the docs do not cover what they cannot find.
  const nav = readNavGroups(source.navGroups);

  return (
    <div
      className="flex h-full min-h-0 w-full"
      data-testid={HELP_SURFACE_V2_TEST_ID}
    >
      <HelpNavPane
        docsSiteUrl={docsSiteUrl}
        isSearching={source.isSearching}
        navEmptyDetail={corpusCopy.navEmptyDetail}
        navGroups={nav.groups}
        onSearchQueryChange={source.onSearchQueryChange}
        onSelect={source.selectPage}
        refusedGroups={nav.refusedGroups}
        searchFailed={source.searchFailed}
        searchHits={source.searchHits}
        searchQuery={source.searchQuery}
        selectedPath={source.selectedPath}
        treeUnreadable={nav.treeUnreadable}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <HelpSurfaceReaderPane
          docsSiteUrl={docsSiteUrl}
          onHeadingHandled={source.onHeadingHandled}
          page={source.page}
          pageMissingDetail={corpusCopy.pageMissingDetail}
          pendingHeadingSlug={source.pendingHeadingSlug}
          slugifyHeading={slugifyHeading}
        />
      </div>
    </div>
  );
}

function HelpSurfaceReaderPane({
  docsSiteUrl,
  onHeadingHandled,
  page,
  pageMissingDetail,
  pendingHeadingSlug,
  slugifyHeading,
}: Readonly<
  Pick<HelpSurfaceV2Props, "slugifyHeading"> & {
    docsSiteUrl: string;
    onHeadingHandled: () => void;
    page: HelpSurfaceV2Props["source"]["page"];
    pageMissingDetail: string;
    pendingHeadingSlug: string | null;
  }
>) {
  if (page.kind === "loading") {
    return <HelpReaderLoading />;
  }
  if (page.kind === "missing") {
    return (
      <HelpReaderMissing detail={pageMissingDetail} docsSiteUrl={docsSiteUrl} />
    );
  }
  if (page.kind === "error") {
    return <HelpReaderUnavailable docsSiteUrl={docsSiteUrl} />;
  }
  if (page.kind === "idle") {
    return null;
  }
  // AC2: `renderBody ?? body` reaches the markdown pipeline directly — a
  // non-nullish non-string throws there, and a nullish one draws a blank page
  // that reads as "this doc is empty".
  const readable = readReaderPage(page.page);
  if (readable === null) {
    return <HelpReaderMalformed docsSiteUrl={docsSiteUrl} />;
  }
  return (
    <HelpReader
      docsSiteUrl={docsSiteUrl}
      onHeadingHandled={onHeadingHandled}
      page={readable}
      pendingHeadingSlug={pendingHeadingSlug}
      slugifyHeading={slugifyHeading}
    />
  );
}

/**
 * No snapshot in this build. Exported because both flag branches render it, and
 * two copies of a sentence is how the branches start telling different stories.
 */
export function HelpBundleUnavailable({
  detail,
  docsSiteUrl,
  title,
}: Readonly<{ detail: string; docsSiteUrl: string; title: string }>) {
  return (
    <EmptyState
      action={<ViewOnlineAction docsSiteUrl={docsSiteUrl} />}
      description={`${detail} You can still read the latest docs online.`}
      icon={BookOpenIcon}
      title={title}
      titleAs="h1"
    />
  );
}

export function HelpSurfaceNavSkeleton() {
  return (
    <div
      aria-hidden
      className={cn(HELP_NAV_PANE_CHROME, "flex flex-col gap-2 p-3")}
    >
      <Skeleton className="mb-2 h-9 w-full" />
      {Array.from({ length: 8 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows.
        <Skeleton className="h-6 w-full" key={index} />
      ))}
    </div>
  );
}
