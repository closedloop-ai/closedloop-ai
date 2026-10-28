import { useOptionalAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { SidebarTeams } from "@repo/app/teams/components/sidebar-teams";

/** Desktop route adapter for the same Teams owner the web sidebar mounts. */
export function DesktopSidebarTeams() {
  const enabled = useFeatureFlagEnabled(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  const { isLoaded, orgId, userId } = useOptionalAuthSnapshot();
  if (!(enabled && isLoaded && orgId && userId)) {
    return null;
  }
  return (
    <SidebarTeams
      buildProjectsHref={(teamId) => `/teams/${teamId}/projects`}
      className="px-0 py-1"
      key={orgId}
      organizationId={orgId}
    />
  );
}
