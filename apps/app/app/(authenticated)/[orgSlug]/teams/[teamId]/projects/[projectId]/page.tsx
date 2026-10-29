"use client";
import { ProjectDetailPage } from "@repo/app/projects/components/project-detail-page";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { Header } from "@/app/(authenticated)/components/header";
import LegacyProjectDetailPage from "./legacy-project-detail-page";

export default function TeamProjectDetailPage() {
  const params = useRouteParams();
  const enabled = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  if (!enabled) {
    return <LegacyProjectDetailPage />;
  }
  const projectId = getStringRouteParam(params, "projectId");
  const teamId = getStringRouteParam(params, "teamId");
  return (
    <ProjectDetailPage
      key={projectId}
      projectId={projectId}
      renderHeader={({ project, teamName, projectsHref, actions }) => (
        <Header
          breadcrumbs={[
            { label: teamName, href: projectsHref },
            { label: project.name },
          ]}
          suppressPageHeading
        >
          {actions}
        </Header>
      )}
      teamId={teamId}
    />
  );
}
