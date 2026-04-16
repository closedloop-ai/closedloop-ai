"use client";

import type { TeamWithCounts } from "@repo/api/src/types/teams";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
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
  ArchiveIcon,
  BoxIcon,
  EllipsisIcon,
  FileCodeIcon,
  FileIcon,
  Layers2Icon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { useDeleteTeam, useTeams } from "@/hooks/queries/use-teams";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { TeamModal } from "./team-modal";

const TEAM_PATTERN = /^\/teams\/([^/]+)/;

type NavItem = {
  label: string;
  href: (teamId: string) => string;
  icon: React.ComponentType<{ className?: string }>;
};

const TEAM_NAV_ITEMS: NavItem[] = [
  {
    label: "Projects",
    href: (id) => `/teams/${id}/projects`,
    icon: Layers2Icon,
  },
  { label: "PRDs", href: (id) => `/teams/${id}/prds`, icon: FileIcon },
  { label: "Features", href: (id) => `/teams/${id}/features`, icon: BoxIcon },
  { label: "Plans", href: (id) => `/teams/${id}/plans`, icon: FileCodeIcon },
];

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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deleteTeam = useDeleteTeam();

  async function handleConfirmDelete(): Promise<boolean> {
    const result = await deleteTeam.mutateAsync(team.id);
    return result.deleted ?? false;
  }

  return (
    <>
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
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip={team.name}>
              <UsersIcon />
              <span>{team.name}</span>
            </SidebarMenuButton>
          </CollapsibleTrigger>
          {mounted ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction showOnHover>
                  <EllipsisIcon />
                  <span className="sr-only">Team options</span>
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem asChild>
                  <Link href={`/teams/${team.id}/projects/archived`}>
                    <ArchiveIcon className="h-4 w-4" />
                    Archived Projects
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                  <SettingsIcon className="h-4 w-4" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setDeleteOpen(true)}
                  variant="destructive"
                >
                  <Trash2Icon className="h-4 w-4 text-destructive" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <CollapsibleContent>
            <SidebarMenuSub>
              {TEAM_NAV_ITEMS.map(({ label, href, icon: Icon }) => (
                <SidebarMenuSubItem key={label}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={pathname.startsWith(href(team.id))}
                  >
                    <Link href={href(team.id)}>
                      <Icon className="h-4 w-4" />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>

      {mounted ? (
        <TeamModal
          onOpenChange={setSettingsOpen}
          open={settingsOpen}
          team={team}
        />
      ) : null}

      <DeleteConfirmationDialog
        isPending={deleteTeam.isPending}
        itemName={team.name}
        onConfirm={handleConfirmDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Team"
      />
    </>
  );
}

export function SidebarTeams() {
  const { data: teams = [] } = useTeams();
  const mounted = useIsMounted();
  const pathname = usePathname();
  const [openTeamIds, setOpenTeamIds] = useState<Set<string>>(new Set());

  // Auto-expand the team matching the current route
  const activeTeamId = useMemo(() => {
    const match = TEAM_PATTERN.exec(pathname);
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
      <SidebarGroupLabel className="flex items-center justify-between">
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
      </SidebarMenu>
    </SidebarGroup>
  );
}
