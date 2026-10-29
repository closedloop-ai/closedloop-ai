// gardener-support: test and story data, not shipped
"use client";

import {
  ACTIVITY_FIXTURE_NOW,
  newestFirst,
} from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { BRANCH_EXAMPLE_ROWS } from "@repo/app/documents/components/artifact-activity/activity-example-timelines.fixtures";
// Feature slice -> documents slice: the Activity tab renders the shared
// Activity timeline (ISS-10843) with the Branch feed's example rows.
import { ActivityTimeline } from "@repo/app/documents/components/artifact-activity/activity-timeline";
import {
  DETAILS_DESIGN_HOST,
  DetailsPriorityEditorHost,
} from "@repo/app/documents/components/details-design/details-design-preview-host";
import { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
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
// sections are the generic-artifact surfaces this harness places on a Branch.
import {
  ArtifactCommentsRail,
  type GenericCommentRecord,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import { branchDetailsTabConfig } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { useDesignCommentsRail } from "@repo/app/shared/hooks/use-design-comments-rail";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { Chip } from "@repo/design-system/components/ui/chip";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { FileIcon } from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useRef,
  useState,
} from "react";
import { resolvePreferredBranchLoc } from "../../lib/preferred-branch-loc";
import { BranchCostToMerge } from "../branch-cost-to-merge";
import { BranchHeadlineCards } from "../branch-headline-cards";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";
import { BranchPullRequestSelector } from "../branch-pull-request-selector";
import { BranchDeliveredPanel } from "../detail/branch-delivered-panel";
import { BranchPrStatusPanel } from "../detail/branch-pr-status-panel";
import {
  designSessionsDetail,
  designSessionsTrace,
} from "../detail/branch-sessions-design-fixtures";
import { BranchSessionsTimelinePanel } from "../detail/branch-sessions-timeline-tab";
import {
  BRANCH_DESIGN_ARTIFACT,
  BRANCH_DESIGN_DETAILS_INPUT,
  BRANCH_DESIGN_FILES,
  BRANCH_DESIGN_NATIVE_COMMENTS,
  BRANCH_DESIGN_PROVIDER_COMMENTS,
  BRANCH_DESIGN_PULL_REQUEST_IDS,
  branchDesignDetailFor,
} from "./branch-detail-design-fixtures";

/**
 * ISS-10963 design-review harness: the Branch detail page in the ISS-10790
 * shell. Nothing in production imports it. It stays as staged design work that
 * Storybook renders (Surfaces/Artifacts/Branches/Branch Detail):
 * ISS-12171 copies its pattern to the remaining artifact types, and ISS-12412
 * builds its Details tab into the production page.
 *
 * - Artifact is today's whole "Branch details" tab, in production order
 *   (Kerensa Whitlock's ruling on ISS-10963, 2026-09-23), so the PR selector scopes
 *   every PR-owned panel and the PR's comments on one tab, like
 *   `BranchSelectedPullRequestWorkspace`, on the framed canvas. No
 *   Properties (ISS-12403): they are the Details tab.
 * - Activity is the fourth tab (Nerys, 2026-10-06, replacing the 2026-09-28
 *   ruling that hid it): the shared Activity timeline with example rows
 *   shaped like `GET /branches/[id]/activity`, newest first. No comments
 *   rail beside it.
 * - Files changed is a stand-in: the real panel mounts a live query this
 *   harness has no provider for.
 * - Sessions is the live Sessions & timeline panel over a full example
 *   (`branch-sessions-design-fixtures.ts`, Nerys 2026-10-22).
 * - Page chrome as the web-master generic artifact prototype lays it out: a
 *   page header row (the host's breadcrumbs, with the comments toggle at its
 *   end where the rail shows), then the tab row with the collaborators.
 */

const BRANCH_DESIGN_TABS = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;
export type BranchDesignTab = (typeof BRANCH_DESIGN_TABS)[number];

const BRANCH_DESIGN_ACTIVITY_ROWS = newestFirst(BRANCH_EXAMPLE_ROWS);

/** The comments rail sits beside these tabs and no others. */
const COMMENTS_TABS: readonly BranchDesignTab[] = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
];

// No in-app router here, and the delivered panel's `Link` throws on a
// root-relative href without one; `.invalid` never resolves.
const artifactHref = (slug: string) =>
  `https://closedloop.invalid/artifacts/${slug.toLowerCase()}`;

/** What the page header row holds; the host lays it out as its own header. */
export type BranchDetailPageHeaderParts = {
  title: string;
  /** Null on a tab with no comments rail. */
  commentsToggle: ReactNode;
};

export function BranchDetailDesignPreview({
  initialTab = ArtifactDetailTab.Artifact,
  pageHeader = BranchDetailFallbackPageHeader,
}: Readonly<{
  /** The tab the page opens on, so a story can open it on any tab. */
  initialTab?: BranchDesignTab;
  /** Renders the page header row; the app's route header in a full page. */
  pageHeader?: (parts: BranchDetailPageHeaderParts) => ReactNode;
}>) {
  const [activeTab, setActiveTab] = useState<BranchDesignTab>(initialTab);
  const [selectedId, setSelectedId] = useState<string>(
    BRANCH_DESIGN_PULL_REQUEST_IDS.Open
  );
  const [commentsWidth, setCommentsWidth] = useState(352);
  // ISS-11209: the rail's drafts live above it, one store per comment view,
  // as in the generic artifact shell.
  const artifactDrafts = useCommentsPaneDrafts(BRANCH_DESIGN_ARTIFACT.id);
  const sessionDrafts = useCommentsPaneDrafts(BRANCH_DESIGN_ARTIFACT.id);
  const [nativeComments, setNativeComments] = useState<GenericCommentRecord[]>(
    () => [...BRANCH_DESIGN_NATIVE_COMMENTS]
  );
  // The Sessions trace comments are ISS-11209/ISS-11213's; this rail shows
  // their empty prompt.
  const [sessionComments, setSessionComments] = useState<
    GenericCommentRecord[]
  >([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const rail = useDesignCommentsRail(rootRef);
  const detail = branchDesignDetailFor(selectedId);
  // Closedloop comments stay with the branch; GitHub comments follow the PR
  // and are read-only, so the rail's writes land in the native list.
  const generalComments = [
    ...nativeComments,
    ...(BRANCH_DESIGN_PROVIDER_COMMENTS[selectedId] ?? []),
  ];
  const setGeneralComments: Dispatch<SetStateAction<GenericCommentRecord[]>> = (
    next
  ) => {
    const nextComments =
      typeof next === "function" ? next(generalComments) : next;
    setNativeComments(
      nextComments.filter((comment) => comment.source?.provider !== "github")
    );
  };
  const commentsShown = COMMENTS_TABS.includes(activeTab);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background" ref={rootRef}>
        {pageHeader({
          commentsToggle:
            commentsShown && rail.available ? (
              <ArtifactCommentsToggle
                onToggle={() => rail.setOpen((open) => !open)}
                open={rail.open}
              />
            ) : null,
          title: detail.branchName,
        })}
        <ArtifactDetailShell
          activeTab={activeTab}
          comments={
            commentsShown && rail.available ? (
              <ArtifactCommentsRail
                activeTab={activeTab}
                {...(activeTab === "sessions" ? sessionDrafts : artifactDrafts)}
                artifact={BRANCH_DESIGN_ARTIFACT}
                availableWidth={rail.availableWidth}
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
              people={collaboratorsFromNames(
                BRANCH_DESIGN_ARTIFACT.collaborators
              )}
            />
          }
          onActiveTabChange={setActiveTab}
          panels={{
            artifact: (
              <BranchArtifactPanel
                onSelectPullRequest={setSelectedId}
                selectedId={selectedId}
              />
            ),
            details: <BranchDetailsPanel />,
            sessions: <BranchSessionsPanel />,
            activity: <BranchActivityPanel />,
          }}
          tabs={BRANCH_DESIGN_TABS}
        />
      </div>
    </TooltipProvider>
  );
}

/**
 * @handrolled `BranchFilesChangedPanel` mounts a diff query per row. Same
 * section chrome and +/- classes as production, no expand-to-diff.
 */
function FilesChangedStandIn({ pullRequestId }: { pullRequestId: string }) {
  const files = BRANCH_DESIGN_FILES[pullRequestId] ?? [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <section aria-labelledby="branch-design-files-title">
      <div className="bq-sec-head">
        <span className="bq-sec-title" id="branch-design-files-title">
          Files changed
        </span>
        <span className="bq-sec-count flex items-center gap-2 tabular-nums">
          {files.length} files
          <span className="font-mono">
            <b className="bq-add">+{additions}</b>{" "}
            <b className="bq-del">−{deletions}</b>
          </span>
        </span>
        <Chip className="ml-auto" size="sm" variant="info">
          GitHub
        </Chip>
      </div>
      <div className="bq-files">
        {files.map((file) => (
          <div className="bq-file" key={file.path}>
            <FileIcon aria-hidden className="bq-file-ic size-3.5" />
            <span className="bq-file-path font-mono">{file.path}</span>
            <span className="shrink-0 pl-2 font-mono text-xs tabular-nums">
              <b className="bq-add">+{file.additions}</b>{" "}
              <b className="bq-del">−{file.deletions}</b>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The Artifact tab: everything scoped to the chosen PR, on the Artifact tab's
 * framed canvas (ISS-12403). No Properties: the branch's properties are its
 * Details tab, as production dropped them from the shell (ISS-12267).
 */
export function BranchArtifactPanel({
  onSelectPullRequest,
  selectedId,
}: {
  onSelectPullRequest: (id: string) => void;
  selectedId: string;
}) {
  const detail = branchDesignDetailFor(selectedId);
  return (
    <ArtifactCanvasPanel label="Branch">
      <BranchPullRequestSelector
        collection={detail.associatedPullRequests}
        onChange={(identity) =>
          onSelectPullRequest(
            `${identity.repositoryFullName}#${identity.pullRequestNumber}`
          )
        }
        selectedId={selectedId}
      />
      <section
        aria-label={`Branch and pull request #${detail.prNumber} evidence`}
      >
        <BranchHeadlineCards detail={detail} />
        <BranchCostToMerge detail={detail} />
        <BranchLeadTimeWaterfall detail={detail} />
        <BranchDeliveredPanel detail={detail} getArtifactHref={artifactHref} />
        <BranchPrStatusPanel detail={detail} />
        <FilesChangedStandIn pullRequestId={selectedId} />
      </section>
    </ArtifactCanvasPanel>
  );
}

/**
 * The Details tab (ISS-12252, ISS-12403): Artifact details, Branch details
 * and Associated artifacts, for the branch the header names.
 */
export function BranchDetailsPanel() {
  return (
    <ArtifactPlainPanel label="Branch details">
      <DetailsTabSections
        config={branchDetailsTabConfig(
          DETAILS_DESIGN_HOST,
          BRANCH_DESIGN_DETAILS_INPUT
        )}
        priorityEditor={DetailsPriorityEditorHost}
      />
    </ArtifactPlainPanel>
  );
}

/**
 * The Sessions tab: the live Sessions & timeline panel the Branch shell
 * mounts (`branch-shell-view.tsx`), PR timeline and combined session trace,
 * over a full example (`designSessionsTrace`): four sessions with every
 * element the trace draws.
 */
export function BranchSessionsPanel() {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  // Containment only, as the live shell has it: the timeline owns its
  // scroller, which needs an overflow-hidden parent to size against.
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <BranchSessionsTimelinePanel
        detail={designSessionsDetail}
        getSessionHref={designSessionHref}
        loc={resolvePreferredBranchLoc(designSessionsDetail)}
        scrollElementRef={scrollElementRef}
        trace={{ data: designSessionsTrace, isLoading: false }}
      />
    </div>
  );
}

/** A design Session's page; the live shell's href is the host route's. */
function designSessionHref(sessionId: string) {
  return `https://closedloop.invalid/sessions/${sessionId}`;
}

/** The Activity tab: the shared Activity timeline with the Branch feed. */
export function BranchActivityPanel() {
  return (
    <ArtifactPlainPanel label="Branch activity">
      <ArtifactTabSection title={ACTIVITY_TIMELINE_TITLE}>
        <ActivityTimeline
          artifactKind={ActivityArtifactKind.Branch}
          now={ACTIVITY_FIXTURE_NOW}
          rows={BRANCH_DESIGN_ACTIVITY_ROWS}
        />
      </ArtifactTabSection>
    </ArtifactPlainPanel>
  );
}

/** The header row when no host supplies one: the name, then the toggle. */
function BranchDetailFallbackPageHeader({
  commentsToggle,
  title,
}: BranchDetailPageHeaderParts) {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3">
      <h1 className="font-medium text-sm">{title}</h1>
      {commentsToggle ? <div className="ml-auto">{commentsToggle}</div> : null}
    </div>
  );
}
