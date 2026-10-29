// gardener-support: test and story data, not shipped
"use client";

import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
// Feature slice -> branches slice: the Sessions tab's fixture is the shared
// Sessions presentation's own (the production Document Sessions tab reuses
// the Branch Sessions panel), the full example the Branch design shows too.
import {
  designSessionsDetail,
  designSessionsTrace,
} from "@repo/app/branches/components/detail/branch-sessions-design-fixtures";
import { ACTIVITY_FIXTURE_NOW } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import {
  ActivityTimeline,
  type ActivityTimelineRow,
} from "@repo/app/documents/components/artifact-activity/activity-timeline";
import {
  DETAILS_DESIGN_HOST,
  DetailsPriorityEditorHost,
} from "@repo/app/documents/components/details-design/details-design-preview-host";
import { DocumentSessionsPanel } from "@repo/app/documents/components/document-sessions-tab";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import {
  ACTIVITY_TIMELINE_TITLE,
  ArtifactPlainPanel,
  ArtifactTabSection,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-plain-panel";
import {
  Collaborators,
  collaboratorsFromNames,
} from "@repo/app/shared/components/collaborators";
import { useCommentsPaneDrafts } from "@repo/app/shared/components/comments/use-comments-pane-drafts";
// Feature slice -> shared: the shared preview's comments rail and Details
// sections are the generic-artifact surfaces these harnesses place on a
// Document and an Issue, as the Branch harness does.
import {
  ArtifactCommentsRail,
  type GenericCommentRecord,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import type { DetailsTabConfig } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { useDesignCommentsRail } from "@repo/app/shared/hooks/use-design-comments-rail";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { type ReactNode, useRef, useState } from "react";
import { AddCommentButton } from "./artifact-canvas-toolbar";

/**
 * ISS-12586 (DI-16): the page shell the Document and Issue Detail design
 * previews share. Nothing in production imports it. It is the Branch Detail
 * harness's composition (`BranchDetailDesignPreview`) with a document's
 * header and panels:
 *
 * - The shipped tab order: Artifact, Sessions, Details, Activity.
 * - The comments rail sits beside Artifact and Sessions only, Branch's rule.
 * - Page chrome as the web-master generic artifact prototype lays it out: a
 *   page header row (the host's breadcrumbs, with the comments toggle at its
 *   end where the rail shows), then the tab row ending with the collaborators.
 *
 * Each page hands it its own panels; the Sessions, Details and Activity
 * panels below are the same for both.
 */

export const DOCUMENT_DESIGN_TABS = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;
export type DocumentDesignTab = (typeof DOCUMENT_DESIGN_TABS)[number];

/** The comments rail sits beside these tabs and no others (as on Branch). */
const COMMENTS_TABS: readonly DocumentDesignTab[] = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
];

/** What the page header row holds; the host lays it out as its own header. */
export type DocumentDetailPageHeaderParts = {
  /** The artifact's slug (DOC-…, ISS-…), shown with its title. */
  slug: string;
  title: string;
  /**
   * Add comment, drawn just before the comments toggle (Nerys, 2026-10-22).
   * Null except on the Artifact tab with the rail mounted.
   */
  addComment?: ReactNode;
  /** Null on a tab with no comments rail. */
  commentsToggle: ReactNode;
};

/** What a page's panels can ask of the shell. */
export type DocumentDesignPanelActions = {
  /** The rail's artifact comments as they stand, including ones just posted. */
  comments: readonly GenericCommentRecord[];
  /** Opens the comments rail. */
  openComments: () => void;
  /** Switches the page to a tab, for a "see all on Activity" link. */
  showTab: (tab: DocumentDesignTab) => void;
};

export function DocumentFamilyDetailDesignShell({
  artifact,
  comments,
  initialTab = ArtifactDetailTab.Artifact,
  pageHeader = DocumentDetailFallbackPageHeader,
  panels,
  quoteSelection,
}: Readonly<{
  /** The artifact the header, rail and collaborators describe. */
  artifact: GenericArtifact;
  /** The rail's comments on open. */
  comments: readonly GenericCommentRecord[];
  initialTab?: DocumentDesignTab;
  /** Renders the page header row; the app's route header in a full page. */
  pageHeader?: (parts: DocumentDetailPageHeaderParts) => ReactNode;
  panels: (
    actions: DocumentDesignPanelActions
  ) => Record<DocumentDesignTab, ReactNode>;
  /**
   * The text `addComment` quotes for the page's current selection, or `null`
   * to comment on the whole artifact (an issue's body, ISS-12576).
   */
  quoteSelection?: (root: HTMLElement) => string | null;
}>) {
  const [activeTab, setActiveTab] = useState<DocumentDesignTab>(initialTab);
  const [commentsWidth, setCommentsWidth] = useState(352);
  // ISS-11209: the rail's drafts live above it, one store per comment view.
  const artifactDrafts = useCommentsPaneDrafts(artifact.id);
  const sessionDrafts = useCommentsPaneDrafts(artifact.id);
  const [generalComments, setGeneralComments] = useState<
    GenericCommentRecord[]
  >(() => [...comments]);
  const [sessionComments, setSessionComments] = useState<
    GenericCommentRecord[]
  >([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const rail = useDesignCommentsRail(rootRef);
  // A quote Add comment asked to comment on. The rail applies each request
  // once, but it remembers that only while it is mounted, and leaving the
  // Artifact tab unmounts it: so the request is cleared on every tab change,
  // and numbered from a counter that never restarts, so no comment id repeats.
  const [draftRequest, setDraftRequest] = useState<{
    anchorPreview: string;
    commentId: string;
    nonce: number;
  } | null>(null);
  const quoteCount = useRef(0);
  const changeTab = (tab: DocumentDesignTab) => {
    setDraftRequest(null);
    setActiveTab(tab);
  };
  const commentsShown = COMMENTS_TABS.includes(activeTab);
  const addComment = () => {
    const quote =
      quoteSelection && rootRef.current
        ? quoteSelection(rootRef.current)
        : null;
    if (quote !== null) {
      quoteCount.current += 1;
      const nonce = quoteCount.current;
      setDraftRequest({
        anchorPreview: quote,
        commentId: `${artifact.id}-quote-${nonce}`,
        nonce,
      });
    }
    rail.setOpen(true);
  };
  const commentsToggle =
    commentsShown && rail.available ? (
      <ArtifactCommentsToggle
        onToggle={() => rail.setOpen((open) => !open)}
        open={rail.open}
      />
    ) : null;

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background" ref={rootRef}>
        {pageHeader({
          addComment:
            activeTab === ArtifactDetailTab.Artifact && commentsToggle ? (
              <AddCommentButton onAddComment={addComment} />
            ) : null,
          commentsToggle,
          slug: artifact.slug,
          title: artifact.title,
        })}
        <ArtifactDetailShell
          activeTab={activeTab}
          comments={
            commentsShown && rail.available ? (
              <ArtifactCommentsRail
                activeTab={activeTab}
                {...(activeTab === ArtifactDetailTab.Sessions
                  ? sessionDrafts
                  : artifactDrafts)}
                artifact={artifact}
                availableWidth={rail.availableWidth}
                draftRequest={
                  activeTab === ArtifactDetailTab.Artifact ? draftRequest : null
                }
                generalComments={generalComments}
                onOpenChange={rail.setOpen}
                onSelectSessionComment={() => undefined}
                onWidthChange={setCommentsWidth}
                open={rail.open}
                sessionComments={sessionComments}
                setGeneralComments={setGeneralComments}
                setSessionComments={setSessionComments}
                width={commentsWidth}
              />
            ) : null
          }
          headerEnd={
            <Collaborators
              people={collaboratorsFromNames(artifact.collaborators)}
            />
          }
          onActiveTabChange={changeTab}
          panels={panels({
            comments: generalComments,
            openComments: () => rail.setOpen(true),
            showTab: changeTab,
          })}
          tabs={DOCUMENT_DESIGN_TABS}
        />
      </div>
    </TooltipProvider>
  );
}

const DESIGN_SESSIONS: DocumentSessionsResponse = {
  detail: {
    id: "document-design-sessions",
    sessions: designSessionsDetail.sessions,
    mergedTrace: [],
    estimatedCostUsd: designSessionsDetail.estimatedCostUsd,
    attributedCostUsd: designSessionsDetail.estimatedCostUsd,
  },
  trace: designSessionsTrace,
};

/**
 * The Sessions tab: the production Document Sessions panel (the Branch
 * Sessions presentation with document-scoped data), fed a fixture. It lists
 * only the sessions that wrote to or commented on the artifact.
 */
export function DocumentDesignSessionsPanel() {
  return (
    <DocumentSessionsPanel
      data={DESIGN_SESSIONS}
      isError={false}
      isLoading={false}
      onRetry={() => undefined}
    />
  );
}

/** The Details tab: the shared Details sections for the page's type. */
export function DocumentDesignDetailsPanel({
  config,
  label,
}: Readonly<{
  config: (host: typeof DETAILS_DESIGN_HOST) => DetailsTabConfig;
  label: string;
}>) {
  return (
    <ArtifactPlainPanel label={label}>
      <DetailsTabSections
        config={config(DETAILS_DESIGN_HOST)}
        priorityEditor={DetailsPriorityEditorHost}
      />
    </ArtifactPlainPanel>
  );
}

/** The Activity tab: the shared Activity timeline, newest first. */
export function DocumentDesignActivityPanel({
  label,
  rows,
}: Readonly<{ label: string; rows: readonly ActivityTimelineRow[] }>) {
  return (
    <ArtifactPlainPanel label={label}>
      <ArtifactTabSection title={ACTIVITY_TIMELINE_TITLE}>
        <ActivityTimeline now={ACTIVITY_FIXTURE_NOW} rows={rows} />
      </ArtifactTabSection>
    </ArtifactPlainPanel>
  );
}

/**
 * The header row when no host supplies one: slug and title, then Add comment
 * and the toggle.
 */
function DocumentDetailFallbackPageHeader({
  addComment,
  commentsToggle,
  slug,
  title,
}: DocumentDetailPageHeaderParts) {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3">
      <span className="font-mono text-muted-foreground text-xs">{slug}</span>
      <h1 className="font-medium text-sm">{title}</h1>
      {commentsToggle ? (
        <div className="ml-auto flex items-center gap-2">
          {addComment}
          {commentsToggle}
        </div>
      ) : null}
    </div>
  );
}
