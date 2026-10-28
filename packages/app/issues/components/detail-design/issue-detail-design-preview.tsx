// gardener-support: test and story data, not shipped
"use client";

import { DocumentType } from "@repo/api/src/types/document";
// Feature slice -> documents slice: the Issue page shares the Document page's
// design shell and the shared Activity timeline (ISS-10843).
import { ActivityBrief } from "@repo/app/documents/components/artifact-activity/activity-brief";
import {
  ACTIVITY_FIXTURE_NOW,
  newestFirst,
} from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { ArtifactCanvasToolbar } from "@repo/app/documents/components/detail-design/artifact-canvas-toolbar";
import {
  DocumentDesignActivityPanel,
  DocumentDesignDetailsPanel,
  DocumentDesignSessionsPanel,
  type DocumentDesignTab,
  type DocumentDetailPageHeaderParts,
  DocumentFamilyDetailDesignShell,
} from "@repo/app/documents/components/detail-design/document-detail-design-shell";
import { DocumentRichTextToolbar } from "@repo/app/documents/components/document-rich-text-toolbar";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import type { GenericCommentRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import { LinkedArtifactGroupsTable } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import { issueDetailsTabConfig } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { Chip } from "@repo/design-system/components/ui/chip";
import { type ReactNode, useId, useState } from "react";
import { IssueCard, selectedIssueBodyQuote } from "../issue-card/issue-card";
import { LinkedWorkCard } from "../linked-work/linked-work-card";
import { IssueStatusStrip } from "../status-strip/issue-status-strip";
import {
  ISSUE_DESIGN_ARTIFACT,
  ISSUE_DESIGN_SCENARIOS,
  ISSUE_DESIGN_STATUS_STRIP,
  type IssueDesignScenario,
  IssueDesignState,
  issueCommentHighlights,
  issueDesignHistory,
} from "./issue-detail-design-fixtures";

/**
 * ISS-12576 (DI-07): the full Issue Detail page in the PRD-751 artifact
 * detail shell, as Branch and Session Detail have it. Nothing in production
 * imports it; Storybook renders it (Surfaces/Labs/Issues/Issue Detail, and a
 * Composites entry per section).
 *
 * Laid out as Ottilie and Nerys settled it on 2026-10-21:
 * - The Artifact tab's canvas opens with a toolbar that stays at its top
 *   while the issue scrolls under it: the issue's slug and its key fields
 *   (DI-08). It is the toolbar a Document's canvas opens with
 *   (`ArtifactCanvasToolbar`); its right end is kept for Publish. It is on
 *   the Artifact tab only. Details shows the same fields, with room.
 * - Add comment is in the page header, just before the comments toggle, on
 *   the Artifact tab (Nerys, 2026-10-22).
 * - Clicking the issue's text starts editing, as clicking a document's body
 *   does in the live editor: the editor's text controls appear in an edit
 *   bar under the toolbar and stay for the visit (Nerys, 2026-10-22).
 * - Under it, in order: the issue's text (DI-07), Sub-issues, Branch (DI-10)
 *   and Activity summary (DI-09), each under its own heading. Sessions have
 *   their own tab, and related artifacts are on the Details tab.
 * - Every comment is in the rail: on a passage of the body, which the body
 *   highlights, or on the issue as a whole.
 * - Sessions, Details (the Issue details group) and Activity are the shared
 *   panels.
 */

/** The page's labelled regions on the Artifact tab, top to bottom. */
export const IssueDesignRegion = {
  Toolbar: "Issue toolbar",
  SubIssues: "Sub-issues",
  Branch: "Branch",
  ActivitySummary: "Activity summary",
} as const;

/** The edit bar's name: the text controls under the toolbar while editing. */
export const ISSUE_EDIT_BAR_LABEL = "Edit bar";

export function IssueDetailDesignPreview({
  initialEditing = false,
  initialTab = ArtifactDetailTab.Artifact,
  pageHeader,
  state = IssueDesignState.Default,
}: Readonly<{
  /** Opens the issue's text already being edited, the edit bar showing. */
  initialEditing?: boolean;
  /** The tab the page opens on, so a story can open it on any tab. */
  initialTab?: DocumentDesignTab;
  /** Renders the page header row; the app's route header in a full page. */
  pageHeader?: (parts: DocumentDetailPageHeaderParts) => ReactNode;
  /** Which of the issue's states the page shows. */
  state?: IssueDesignState;
}>) {
  const scenario = ISSUE_DESIGN_SCENARIOS[state];
  return (
    <DocumentFamilyDetailDesignShell
      artifact={ISSUE_DESIGN_ARTIFACT}
      comments={scenario.comments}
      initialTab={initialTab}
      // Each state is its own issue: its rail and drafts start fresh.
      key={state}
      pageHeader={pageHeader}
      panels={({ comments, showTab }) => ({
        [ArtifactDetailTab.Artifact]: (
          <IssueArtifactPanel
            comments={comments}
            initialEditing={initialEditing}
            onShowActivity={() => showTab(ArtifactDetailTab.Activity)}
            scenario={scenario}
          />
        ),
        [ArtifactDetailTab.Sessions]: <IssueSessionsDesignPanel />,
        [ArtifactDetailTab.Details]: <IssueDetailsDesignPanel />,
        [ArtifactDetailTab.Activity]: (
          <IssueActivityDesignPanel scenario={scenario} />
        ),
      })}
      quoteSelection={selectedIssueBodyQuote}
    />
  );
}

/**
 * The canvas toolbar (DI-07, DI-08): the toolbar every document-family
 * canvas opens with (`ArtifactCanvasToolbar`), staying at the top while the
 * issue scrolls. The issue's slug and key fields on the left. While the
 * issue's text is being edited, the editor's text controls show in an edit
 * bar under it.
 */
export function IssueDesignToolbar({
  editing = false,
  scenario = ISSUE_DESIGN_SCENARIOS[IssueDesignState.Default],
}: Readonly<{
  /** The issue's text is being edited: the edit bar shows. */
  editing?: boolean;
  scenario?: IssueDesignScenario;
}>) {
  const strip = ISSUE_DESIGN_STATUS_STRIP;
  return (
    <ArtifactCanvasToolbar
      editBar={
        editing ? (
          <div aria-label={ISSUE_EDIT_BAR_LABEL} role="toolbar">
            {/* The live editor's controls, as `DocumentEditorScaffold`
                mounts them. No editor here, so they change nothing. */}
            <DocumentRichTextToolbar
              className="border-0 bg-transparent p-0"
              editor={null}
              onPasteMarkdown={() => undefined}
            />
          </div>
        ) : null
      }
      label={IssueDesignRegion.Toolbar}
      left={
        <IssueStatusStrip
          dueDate={strip.dueDate}
          issueId={ISSUE_DESIGN_ARTIFACT.id}
          metadata={{
            ...strip.metadata,
            assignee: scenario.owner,
            status: scenario.status,
          }}
          slug={ISSUE_DESIGN_ARTIFACT.slug}
        />
      }
    />
  );
}

/**
 * The Artifact tab: the toolbar, then the issue's text, its sub-issues, its
 * branches and its activity summary.
 */
export function IssueArtifactPanel({
  comments,
  initialEditing = false,
  onShowActivity,
  scenario = ISSUE_DESIGN_SCENARIOS[IssueDesignState.Default],
}: Readonly<{
  /** The rail's comments as they stand; defaults to the state's own. */
  comments?: readonly GenericCommentRecord[];
  /** Opens with the issue's text already being edited. */
  initialEditing?: boolean;
  onShowActivity: () => void;
  scenario?: IssueDesignScenario;
}>) {
  // As the live editor's inline edit mode (`useInlineEditMode`): a click on
  // the text starts editing, and editing stays on for the visit.
  const [editing, setEditing] = useState(initialEditing);
  return (
    <ArtifactCanvasPanel label="Issue">
      <IssueDesignToolbar editing={editing} scenario={scenario} />
      <div className="space-y-8 pt-6">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit wrapper, as the live editor's body (`editor-with-anchored-comments.tsx`) */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above */}
        <div
          className={editing ? undefined : "cursor-text"}
          onClick={() => setEditing(true)}
        >
          <IssueCard
            body={scenario.body}
            highlights={issueCommentHighlights(comments ?? scenario.comments)}
            parent={scenario.parent}
            sync={scenario.sync}
            title={ISSUE_DESIGN_ARTIFACT.title}
          />
        </div>
        {scenario.subIssues.length > 0 ? (
          <IssueCanvasSection title={IssueDesignRegion.SubIssues}>
            {/* One rounded group, like the cards below it. */}
            <div className="overflow-hidden rounded-lg border [&_section]:border-y-0">
              <LinkedArtifactGroupsTable
                groups={[
                  {
                    key: "sub-issues",
                    heading: IssueDesignRegion.SubIssues,
                    rows: scenario.subIssues,
                    // The section heading says what they are and how they
                    // relate.
                    hideHeading: true,
                    hideRelationship: true,
                  },
                ]}
              />
            </div>
          </IssueCanvasSection>
        ) : null}
        <IssueCanvasSection
          label={IssueDesignRegion.Branch}
          title={scenario.branches.length > 1 ? "Branches" : "Branch"}
        >
          <LinkedWorkCard branches={scenario.branches} />
        </IssueCanvasSection>
        {scenario.otherLinks ? (
          <IssueCanvasSection title="Other links">
            <div className="space-y-2 rounded-lg border border-dashed p-4">
              <Chip size="sm" variant="muted">
                Future state
              </Chip>
              <ul className="space-y-1 font-mono text-muted-foreground text-xs">
                {scenario.otherLinks.map((url) => (
                  <li key={url}>{url}</li>
                ))}
              </ul>
            </div>
          </IssueCanvasSection>
        ) : null}
        <IssueCanvasSection title={IssueDesignRegion.ActivitySummary}>
          <ActivityBrief
            documentType={DocumentType.Feature}
            now={ACTIVITY_FIXTURE_NOW}
            onShowActivity={onShowActivity}
            rows={issueDesignHistory(scenario.status)}
          />
        </IssueCanvasSection>
      </div>
    </ArtifactCanvasPanel>
  );
}

/** A block of the issue canvas under its own heading. */
function IssueCanvasSection({
  children,
  label,
  title,
}: Readonly<{
  children: ReactNode;
  /** The region's name when it differs from the visible heading. */
  label?: string;
  title: string;
}>) {
  const headingId = useId();
  return (
    <section
      aria-label={label}
      aria-labelledby={label ? undefined : headingId}
      className="space-y-2"
    >
      <h3 className="font-medium text-sm" id={headingId}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The Sessions tab: the sessions that wrote to or commented on the issue. */
export function IssueSessionsDesignPanel() {
  return <DocumentDesignSessionsPanel />;
}

/** The Details tab: Artifact details, then the Issue details group. */
export function IssueDetailsDesignPanel() {
  return (
    <DocumentDesignDetailsPanel
      config={(host) => issueDetailsTabConfig(host, ISSUE_DESIGN_ARTIFACT)}
      label="Issue details"
    />
  );
}

/** The Activity tab: the Issue feed, newest first. */
export function IssueActivityDesignPanel({
  scenario = ISSUE_DESIGN_SCENARIOS[IssueDesignState.Default],
}: Readonly<{ scenario?: IssueDesignScenario }>) {
  return (
    <DocumentDesignActivityPanel
      label="Issue activity"
      rows={newestFirst(issueDesignHistory(scenario.status))}
    />
  );
}
