"use client";

import { SidebarTeams as SharedSidebarTeams } from "@repo/app/teams/components/sidebar-teams";
import { useNavOrgSlug } from "@/hooks/use-org-slug";

export function SidebarTeams({ className }: { className?: string } = {}) {
  const orgSlug = useNavOrgSlug();
  return (
    <SharedSidebarTeams
      buildProjectsHref={(teamId) =>
        orgSlug ? `/${orgSlug}/teams/${teamId}/projects` : null
      }
      className={className}
    />
  );
}
