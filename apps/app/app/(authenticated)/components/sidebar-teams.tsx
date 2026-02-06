"use client";

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
import { useTeams } from "@/hooks/queries/use-teams";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { TeamModal } from "./team-modal";

export function SidebarTeams() {
  const { data: teams = [] } = useTeams();
  const mounted = useIsMounted();

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
          <Collapsible asChild defaultOpen={false} key={team.id}>
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
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton asChild>
                      <Link href={`/teams/${team.id}/projects`}>
                        <FolderIcon className="h-4 w-4" />
                        <span>Projects</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
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
