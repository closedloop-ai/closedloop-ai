"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { useFavoriteProjects } from "@repo/app/projects/hooks/use-projects";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import { useDeleteTeam, useTeams } from "@repo/app/teams/hooks/use-teams";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { Link } from "@repo/navigation/link";
import { usePath } from "@repo/navigation/use-path";
import {
  ArchiveIcon,
  EllipsisIcon,
  Layers2Icon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { TeamModal } from "@/app/(authenticated)/[orgSlug]/teams/components/team-modal";
import { useOrgSlug } from "@/hooks/use-org-slug";

function groupFavoritesByTeam(
  favorites: ProjectWithDetails[]
): Map<string, ProjectWithDetails[]> {
  const grouped = new Map<string, ProjectWithDetails[]>();
  for (const project of favorites) {
    const teamId = project.teams[0]?.id;
    if (!teamId) {
      continue;
    }
    const existing = grouped.get(teamId);
    if (existing) {
      existing.push(project);
    } else {
      grouped.set(teamId, [project]);
    }
  }
  return grouped;
}

type TeamRowProps = {
  team: TeamWithCounts;
  orgSlug: string;
  pathname: string;
  favorites: ProjectWithDetails[];
};

function TeamRow({ team, orgSlug, pathname, favorites }: TeamRowProps) {
  const mounted = useIsMounted();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteTeam = useDeleteTeam();
  const teamHref = `/${orgSlug}/teams/${team.id}/projects`;
  const hasFavorites = favorites.length > 0;

  async function handleConfirmDelete(): Promise<boolean> {
    // Return false (rather than rejecting) on failure so the dialog stays open
    // and DeleteConfirmationDialog.handleDelete doesn't see an unhandled
    // rejection; the global mutation onError still surfaces the error toast.
    try {
      const result = await deleteTeam.mutateAsync(team.id);
      return result.deleted ?? false;
    } catch {
      return false;
    }
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        className="text-sm"
        isActive={
          pathname === teamHref ||
          pathname.startsWith(`${teamHref}/`) ||
          pathname.startsWith(`/${orgSlug}/teams/${team.id}/`)
        }
        tooltip={team.name}
      >
        <Link href={teamHref}>
          <UsersIcon />
          <span className="truncate">{team.name}</span>
        </Link>
      </SidebarMenuButton>
      {mounted && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction
              aria-label="Team options"
              className="[&>svg]:size-3.5"
              showOnHover
            >
              <EllipsisIcon />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuItem asChild>
              <Link href={`/${orgSlug}/teams/${team.id}/projects/archived`}>
                <ArchiveIcon className="h-4 w-4" />
                Archived Projects
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <SettingsIcon className="h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setDeleteOpen(true)}
              variant="destructive"
            >
              <Trash2Icon className="h-4 w-4 text-destructive" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {hasFavorites && (
        <SidebarMenuSub className="mr-0 gap-0 pr-0">
          {favorites.map((project) => {
            const projectHref = `/${orgSlug}/teams/${team.id}/projects/${project.id}`;
            return (
              <SidebarMenuSubItem key={project.id}>
                <SidebarMenuSubButton
                  asChild
                  className="pr-0"
                  isActive={pathname === projectHref}
                >
                  <Link href={projectHref}>
                    <Layers2Icon />
                    <span>{project.name}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      )}
      {mounted && (
        <TeamModal
          onOpenChange={setSettingsOpen}
          open={settingsOpen}
          team={team}
        />
      )}
      <DeleteConfirmationDialog
        isPending={deleteTeam.isPending}
        itemName={team.name}
        onConfirm={handleConfirmDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Team"
      />
    </SidebarMenuItem>
  );
}

export function SidebarTeams() {
  const { data: teams = [], isError: teamsError } = useTeams();
  const { data: favorites = [] } = useFavoriteProjects();
  const mounted = useIsMounted();
  const pathname = usePath();
  const orgSlug = useOrgSlug();

  const favoritesByTeam = useMemo(
    () => groupFavoritesByTeam(favorites),
    [favorites]
  );

  return (
    <SidebarCollapsibleSection
      action={
        mounted ? (
          <TeamModal
            trigger={
              <button
                className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
                type="button"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                <span className="sr-only">Add Team</span>
              </button>
            }
          />
        ) : (
          <div className="h-5 w-5" />
        )
      }
      title="Your Teams"
    >
      <SidebarMenu className="gap-0">
        {teamsError && (
          <SidebarMenuItem>
            <div className="px-2 py-1.5 text-muted-foreground text-xs">
              Teams unavailable
            </div>
          </SidebarMenuItem>
        )}
        {teams.map((team) => (
          <TeamRow
            favorites={favoritesByTeam.get(team.id) ?? []}
            key={team.id}
            orgSlug={orgSlug}
            pathname={pathname}
            team={team}
          />
        ))}
      </SidebarMenu>
    </SidebarCollapsibleSection>
  );
}
