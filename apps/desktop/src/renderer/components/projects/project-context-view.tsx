import { ProjectDetailPage } from "@repo/app/projects/components/project-detail-page";
import { ProjectIndexPage } from "@repo/app/projects/components/project-index-page";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/** Desktop owns routing; all reads, writes and project presentation are shared. */
export function ProjectContextView({
  teamId,
  projectId,
  archived,
}: {
  teamId: string;
  projectId?: string;
  archived: boolean;
}) {
  const enabled = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  if (!enabled) {
    return null;
  }
  if (projectId) {
    return (
      <ProjectDetailPage
        key={projectId}
        projectId={projectId}
        teamId={teamId}
      />
    );
  }
  return (
    <ProjectIndexPage
      archived={archived}
      key={`${teamId}:${archived}`}
      teamId={teamId}
    />
  );
}
