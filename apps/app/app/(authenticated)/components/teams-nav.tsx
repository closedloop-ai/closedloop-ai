"use client";

import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { Button } from "@repo/design-system/components/ui/button";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  Loader2Icon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getTeams } from "@/app/actions/teams";

type TeamsNavProps = {
  /** Whether the current user can add teams (org owner/admin or no org) */
  canAddTeam?: boolean;
  /** Callback when add team button is clicked */
  onAddTeam?: () => void;
};

/**
 * TeamsNav displays the "Your Teams" section in the sidebar
 * Each team is collapsible with Projects and Documents sub-items
 */
export function TeamsNav({ canAddTeam = true, onAddTeam }: TeamsNavProps) {
  const [teams, setTeams] = useState<TeamWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track which teams are expanded
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());

  // Fetch teams on mount
  useEffect(() => {
    async function fetchTeams() {
      setLoading(true);
      setError(null);
      const result = await getTeams();
      if (result.success) {
        setTeams(result.data);
        // Expand first team by default
        if (result.data.length > 0) {
          setExpandedTeams(new Set([result.data[0].id]));
        }
      } else {
        setError(result.error);
      }
      setLoading(false);
    }
    fetchTeams();
  }, []);

  const toggleTeam = (teamId: string) => {
    setExpandedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) {
        next.delete(teamId);
      } else {
        next.add(teamId);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Your Teams</SidebarGroupLabel>
        <div className="flex items-center justify-center py-4">
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      </SidebarGroup>
    );
  }

  if (error) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Your Teams</SidebarGroupLabel>
        <div className="px-2 py-4 text-muted-foreground text-sm">
          Failed to load teams
        </div>
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup>
      <div className="flex items-center justify-between pr-2">
        <SidebarGroupLabel>Your Teams</SidebarGroupLabel>
        {canAddTeam ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="h-5 w-5"
                onClick={onAddTeam}
                size="icon"
                variant="ghost"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                <span className="sr-only">Add team</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Add team</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <SidebarMenu>
        {teams.length === 0 ? (
          <div className="px-2 py-4">
            <p className="mb-2 text-muted-foreground text-sm">No teams yet</p>
            {canAddTeam ? (
              <Button
                className="w-full"
                onClick={onAddTeam}
                size="sm"
                variant="outline"
              >
                <PlusIcon className="mr-1.5 h-3.5 w-3.5" />
                Create your first team
              </Button>
            ) : null}
          </div>
        ) : (
          teams.map((team) => (
            <Collapsible
              asChild
              key={team.id}
              onOpenChange={() => toggleTeam(team.id)}
              open={expandedTeams.has(team.id)}
            >
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={team.name}>
                  <UsersIcon className="h-4 w-4" />
                  <span>{team.name}</span>
                </SidebarMenuButton>
                <CollapsibleTrigger asChild>
                  <SidebarMenuAction className="data-[state=open]:rotate-90">
                    <ChevronRightIcon />
                    <span className="sr-only">Toggle {team.name}</span>
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
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        className={cn(
                          "pointer-events-none cursor-not-allowed opacity-50"
                        )}
                      >
                        <FileTextIcon className="h-4 w-4" />
                        <span>Documents</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          ))
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
