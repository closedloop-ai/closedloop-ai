import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { LayoutRegion } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell.story-fixtures";
import {
  ARTIFACT_DETAIL_TABS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import { type ReactNode, useState } from "react";

/**
 * The live document editor's layout, shared by PRD and Implementation Plan
 * Detail: each is `DocumentEditorScaffold`, which renders the ISS-10790
 * artifact detail shell with the full tab set (`ARTIFACT_DETAIL_TABS`) under
 * the editor's route header (ISS-12171). The Labs Document and Issue Detail
 * patterns follow their PRD-751 surfaces instead
 * (`document-family-detail-layout.tsx`).
 *
 * The header row holds the breadcrumbs, the page actions and the side panel
 * toggle; the scaffold mounts the feed rail beside every tab, and passes no
 * tab-row actions and no collaborators. Every slot is an empty, named region.
 */
export function DocumentDetailLayout({
  initialTab = ArtifactDetailTab.Artifact,
}: Readonly<{ initialTab?: ArtifactDetailTab }>) {
  const [activeTab, setActiveTab] = useState<ArtifactDetailTab>(initialTab);
  return (
    <div className="flex h-[42rem] flex-col bg-background">
      <div
        className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4"
        data-testid="page-header"
      >
        <LayoutRegion
          className="h-8 w-64"
          label="Breadcrumbs"
          testId="page-header-breadcrumbs"
        />
        <div className="flex items-center gap-2">
          <LayoutRegion
            className="h-8 w-32"
            label="Page actions"
            testId="page-header-actions"
          />
          <LayoutRegion
            className="h-8 w-36"
            label="Comments toggle"
            testId="page-header-comments-toggle"
          />
        </div>
      </div>
      <ArtifactDetailShell
        activeTab={activeTab}
        comments={
          <aside
            aria-label="Comments"
            className="flex w-80 shrink-0 flex-col border-l p-4 max-md:hidden"
            data-testid="rail-content"
          >
            <LayoutRegion className="flex-1" label="Comments rail region" />
          </aside>
        }
        onActiveTabChange={setActiveTab}
        panels={PANELS}
        tabs={ARTIFACT_DETAIL_TABS}
      />
    </div>
  );
}

const PANEL_LABELS: Record<ArtifactDetailTab, string> = {
  [ArtifactDetailTab.Artifact]: "Artifact tab region",
  [ArtifactDetailTab.Details]: "Details tab region",
  [ArtifactDetailTab.Sessions]: "Sessions tab region",
  [ArtifactDetailTab.Activity]: "Activity tab region",
};

const PANELS = Object.fromEntries(
  ARTIFACT_DETAIL_TABS.map((tab) => [
    tab,
    <LayoutRegion
      className="m-4 min-h-64 flex-1"
      key={tab}
      label={PANEL_LABELS[tab]}
      testId={`panel-${tab}`}
    />,
  ])
) as Record<ArtifactDetailTab, ReactNode>;
