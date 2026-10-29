import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { LayoutRegion } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell.story-fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { type ReactNode, useState } from "react";

/**
 * The PRD-751 Document and Issue Detail pages' layout, as their Labs surfaces
 * lay them out (`DocumentFamilyDetailDesignShell`, ISS-12586; the Issue canvas
 * as Ottilie and Nerys settled it on 2026-10-21, ISS-12576):
 *
 * - The page header row: breadcrumbs ending in the artifact's slug and
 *   title, then Add comment (Artifact tab only) and the comments toggle on
 *   the tabs the rail sits beside (Nerys, 2026-10-22).
 * - The tab row (Artifact, Sessions, Details, Activity) ending with the
 *   collaborators.
 * - The comments rail beside Artifact and Sessions only, Branch's rule.
 * - The Artifact tab's canvas opens with one toolbar for both (Nerys,
 *   2026-10-22) that stays at the top while the canvas scrolls, its right
 *   end kept for Publish. A Document's holds the live editor's text
 *   controls, always on, and its version dropdown, then its body; an
 *   Issue's holds its slug and key fields, with the text controls in an
 *   edit bar under it while its text is edited, then its text, Sub-issues,
 *   Branch and Activity summary. Issues have no versions.
 *
 * Every slot is an empty, named region. PRD and Plan Detail keep the live
 * editor's layout (`document-detail-layout.tsx`).
 */

export const DocumentFamilyCanvas = {
  Document: "document",
  Issue: "issue",
} as const;
export type DocumentFamilyCanvas =
  (typeof DocumentFamilyCanvas)[keyof typeof DocumentFamilyCanvas];

const TABS = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;
type Tab = (typeof TABS)[number];

/** The comments rail sits beside these tabs and no others. */
const COMMENTS_TABS: readonly Tab[] = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
];

/** The Artifact canvas's regions, top to bottom. */
export const CANVAS_REGIONS: Record<DocumentFamilyCanvas, readonly string[]> = {
  [DocumentFamilyCanvas.Document]: [
    "Toolbar: text controls, version dropdown, Publish (reserved)",
    "Document body",
  ],
  [DocumentFamilyCanvas.Issue]: [
    "Toolbar: slug, key fields, Publish (reserved)",
    "Issue text",
    "Sub-issues",
    "Branch",
    "Activity summary",
  ],
};

/** Under an Issue's toolbar while its text is being edited. */
export const ISSUE_EDIT_BAR_REGION = "Edit bar while editing: text controls";

export function DocumentFamilyDetailLayout({
  canvas,
  initialTab = ArtifactDetailTab.Artifact,
}: Readonly<{ canvas: DocumentFamilyCanvas; initialTab?: Tab }>) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const commentsShown = COMMENTS_TABS.includes(activeTab);
  return (
    <div className="flex h-[42rem] flex-col bg-background">
      <div
        className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4"
        data-testid="page-header"
      >
        <LayoutRegion
          className="h-8 w-72"
          label="Breadcrumbs: slug and title"
          testId="page-header-breadcrumbs"
        />
        {commentsShown ? (
          <div className="flex items-center gap-2">
            {activeTab === ArtifactDetailTab.Artifact ? (
              <LayoutRegion
                className="h-8 w-28"
                label="Add comment"
                testId="page-header-add-comment"
              />
            ) : null}
            <LayoutRegion
              className="h-8 w-36"
              label="Comments toggle"
              testId="page-header-comments-toggle"
            />
          </div>
        ) : null}
      </div>
      <ArtifactDetailShell
        activeTab={activeTab}
        comments={
          commentsShown ? (
            <aside
              aria-label="Comments"
              className="flex w-80 shrink-0 flex-col border-l p-4 max-md:hidden"
              data-testid="rail-content"
            >
              <LayoutRegion className="flex-1" label="Comments rail region" />
            </aside>
          ) : null
        }
        headerEnd={
          <LayoutRegion
            className="h-8 w-28"
            label="Collaborators"
            testId="tab-row-collaborators"
          />
        }
        onActiveTabChange={setActiveTab}
        panels={{
          [ArtifactDetailTab.Artifact]: <ArtifactCanvas canvas={canvas} />,
          [ArtifactDetailTab.Sessions]: <TabRegion tab="Sessions" />,
          [ArtifactDetailTab.Details]: <TabRegion tab="Details" />,
          [ArtifactDetailTab.Activity]: <TabRegion tab="Activity" />,
        }}
        tabs={TABS}
      />
    </div>
  );
}

function ArtifactCanvas({ canvas }: { canvas: DocumentFamilyCanvas }) {
  const [first, ...rest] = CANVAS_REGIONS[canvas];
  return (
    <ArtifactCanvasPanel label={`${CANVAS_LABEL[canvas]} canvas`}>
      <div data-testid="panel-artifact">
        <div
          className="sticky top-0 z-10 -mx-5 -mt-4 bg-card"
          data-testid="canvas-top"
        >
          <LayoutRegion className="h-10" label={first ?? ""} />
          {canvas === DocumentFamilyCanvas.Issue ? (
            <LayoutRegion className="mt-1 h-10" label={ISSUE_EDIT_BAR_REGION} />
          ) : null}
        </div>
        <div className="space-y-4 pt-4">
          {rest.map((region) => (
            <CanvasRegion key={region} label={region} />
          ))}
        </div>
      </div>
    </ArtifactCanvasPanel>
  );
}

const CANVAS_LABEL: Record<DocumentFamilyCanvas, string> = {
  [DocumentFamilyCanvas.Document]: "Document",
  [DocumentFamilyCanvas.Issue]: "Issue",
};

function CanvasRegion({ label }: { label: string }) {
  return (
    <LayoutRegion
      className={
        label.endsWith("body") || label === "Issue text" ? "h-64" : "h-28"
      }
      label={label}
      testId="canvas-region"
    />
  );
}

function TabRegion({ tab }: { tab: string }): ReactNode {
  return (
    <LayoutRegion
      className="m-4 min-h-64 flex-1"
      label={`${tab} tab region`}
      testId={`panel-${tab.toLowerCase()}`}
    />
  );
}
