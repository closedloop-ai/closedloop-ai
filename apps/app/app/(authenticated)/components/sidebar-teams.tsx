"use client";

import type { TeamWithCounts } from "@repo/api/src/types/teams";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@repo/design-system/components/ui/sidebar";
import {
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useRecentProjectsByTeam } from "@/hooks/queries/use-projects";
import { useTeams } from "@/hooks/queries/use-teams";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { DroppableProjectItem } from "./droppable-project-item";
import { TeamModal } from "./team-modal";

const PROJECT_DETAIL_PATTERN = /^\/teams\/([^/]+)\/projects\/[^/]+/;

type TeamCollapsibleProps = {
  team: TeamWithCounts;
  pathname: string;
  openTeamIds: Set<string>;
  setOpenTeamIds: React.Dispatch<React.SetStateAction<Set<string>>>;
};

function TeamCollapsible({
  team,
  pathname,
  openTeamIds,
  setOpenTeamIds,
}: TeamCollapsibleProps) {
  const mounted = useIsMounted();
  const { data: recentProjects, isLoading: isLoadingRecent } =
    useRecentProjectsByTeam(team.id, {
      enabled: openTeamIds.has(team.id),
    });

  return (
    <Collapsible
      asChild
      onOpenChange={(isOpen) => {
        setOpenTeamIds((prev) => {
          const next = new Set(prev);
          if (isOpen) {
            next.add(team.id);
          } else {
            next.delete(team.id);
          }
          return next;
        });
      }}
      open={openTeamIds.has(team.id)}
    >
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip={team.name}>
          <Link href={`/teams/${team.id}/projects`}>
            <UsersIcon />
            <span>{team.name}</span>
          </Link>
        </SidebarMenuButton>
        <CollapsibleTrigger asChild>
          <SidebarMenuAction className="data-[state=open]:rotate-90">
            <ChevronRightIcon />
            <span className="sr-only">Toggle</span>
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {isLoadingRecent &&
              openTeamIds.has(team.id) &&
              [1, 2, 3].map((i) => (
                <SidebarMenuSubItem key={`skeleton-${i}`}>
                  <SidebarMenuSubButton>
                    <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                    <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            {recentProjects?.map((project) => (
              <SidebarMenuSubItem key={project.id}>
                <DroppableProjectItem projectId={project.id}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={
                      pathname === `/teams/${team.id}/projects/${project.id}`
                    }
                  >
                    <Link href={`/teams/${team.id}/projects/${project.id}`}>
                      <FolderIcon className="h-4 w-4" />
                      <span>{project.name}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </DroppableProjectItem>
              </SidebarMenuSubItem>
            ))}
            {mounted ? (
              <SidebarMenuSubItem>
                <TeamModal
                  team={team}
                  trigger={
                    <SidebarMenuSubButton>
                      <SettingsIcon className="h-4 w-4" />
                      <span>Settings</span>
                    </SidebarMenuSubButton>
                  }
                />
              </SidebarMenuSubItem>
            ) : null}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

export function SidebarTeams() {
  const { data: teams = [] } = useTeams();
  const mounted = useIsMounted();
  const pathname = usePathname();
  const [openTeamIds, setOpenTeamIds] = useState<Set<string>>(new Set());

  // Auto-expand the team whose project is currently being viewed
  const activeTeamId = useMemo(() => {
    const match = pathname.match(PROJECT_DETAIL_PATTERN);
    return match?.[1];
  }, [pathname]);

  useEffect(() => {
    if (activeTeamId) {
      setOpenTeamIds((prev) => {
        if (prev.has(activeTeamId)) {
          return prev;
        }
        return new Set(prev).add(activeTeamId);
      });
    }
  }, [activeTeamId]);

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center justify-between pr-2">
        <span>Your Teams</span>
        {mounted ? (
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
        )}
      </SidebarGroupLabel>
      <SidebarMenu>
        {teams.map((team) => (
          <TeamCollapsible
            key={team.id}
            openTeamIds={openTeamIds}
            pathname={pathname}
            setOpenTeamIds={setOpenTeamIds}
            team={team}
          />
        ))}
        {teams.length === 0 && mounted && (
          <SidebarMenuItem>
            <TeamModal
              trigger={
                <SidebarMenuButton className="text-muted-foreground text-sm">
                  <PlusIcon className="h-4 w-4" />
                  <span>Create a team</span>
                </SidebarMenuButton>
              }
            />
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
