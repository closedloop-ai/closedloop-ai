"use client";

import { Suspense } from "react";
import { InboxV2 } from "../../../../../inbox/components/web-master-preview/inbox-v2"; // Cross-slice: preview shell hosts the Inbox preview (ISS-12938).
import { DashboardEmptySurface } from "../components/dashboard-empty-surface";
import { PageChrome } from "../components/page-chrome";
import { SettingsSurface } from "../components/settings-surface";
import type { SpecializedArtifactKind } from "../components/specialized-artifact-kinds";
import { SpecializedArtifactPage } from "../components/specialized-artifact-page";
import { ProjectDetail } from "../projects/project-detail";

export function WebMasterDashboardRoute() {
  return (
    <PageChrome breadcrumbs={[{ label: "Dashboard", isCurrent: true }]}>
      <DashboardEmptySurface />
    </PageChrome>
  );
}

export function WebMasterInboxRoute() {
  return (
    <Suspense fallback={null}>
      <InboxV2 />
    </Suspense>
  );
}

/** `section` is the raw `?section=` value the host route read. */
export function WebMasterSettingsRoute({ section }: { section?: string }) {
  return (
    <PageChrome breadcrumbs={[{ label: "Settings", isCurrent: true }]}>
      <SettingsSurface
        initialPanel={section === "members" ? "members" : "profile"}
      />
    </PageChrome>
  );
}

export function WebMasterSpecializedArtifactRoute({
  kind,
}: {
  kind: SpecializedArtifactKind;
}) {
  return <SpecializedArtifactPage kind={kind} />;
}

export function WebMasterProjectDetailRoute() {
  return <ProjectDetail />;
}
