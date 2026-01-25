"use client";

import type {
  ProjectOwner,
  ProjectWithDetails,
} from "@repo/api/src/types/organization";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { HexagonProgress } from "@repo/design-system/components/ui/hexagon-progress";
import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  type User as PopoverUser,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import {
  FolderIcon,
  MoreHorizontalIcon,
  TrashIcon,
  UserIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { ensureDate, formatDateCompact } from "@/lib/date-utils";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

type ProjectsTableProps = {
  projects: ProjectWithDetails[];
  teamId: string;
  onUpdateOwner?: (projectId: string, owner: ProjectOwner | null) => void;
  onUpdateTargetDate?: (projectId: string, date: Date | null) => void;
  onDelete?: (projectId: string) => Promise<void>;
};

export function ProjectsTable({
  projects,
  teamId,
  onUpdateOwner,
  onUpdateTargetDate,
  onDelete,
}: ProjectsTableProps) {
  const router = useRouter();
  const { data: usersResult } = useOrganizationUsers();

  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => Promise.resolve()),
    getId: (project: ProjectWithDetails) => project.id,
  });

  // Transform organization users for the popover
  const orgUsers: PopoverUser[] = useMemo(() => {
    if (!usersResult?.success) {
      return [];
    }
    return usersResult.data.map((user) => ({
      id: user.id,
      name: getUserDisplayName(user),
      email: user.email,
      avatarUrl: user.avatarUrl ?? undefined,
      initials: getUserInitials(user.firstName, user.lastName),
    }));
  }, [usersResult]);

  const handleRowClick = (project: ProjectWithDetails) => {
    router.push(`/teams/${teamId}/projects/${project.id}`);
  };

  const handleDateChange = (projectId: string, date: Date | null) => {
    if (onUpdateTargetDate) {
      onUpdateTargetDate(projectId, date);
    }
  };

  const handleOwnerChange = (projectId: string, user: PopoverUser | null) => {
    if (onUpdateOwner) {
      const owner: ProjectOwner | null = user
        ? {
            id: user.id,
            firstName: user.name.split(" ")[0] || null,
            lastName: user.name.split(" ").slice(1).join(" ") || null,
            avatarUrl: user.avatarUrl ?? null,
          }
        : null;
      onUpdateOwner(projectId, owner);
    }
  };

  if (projects.length === 0) {
    return (
      <EmptyState
        description="Create your first project to get started."
        icon={FolderIcon}
        title="No projects yet"
      />
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project Name</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Target Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[50px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => (
            <TableRow
              className="cursor-pointer"
              key={project.id}
              onClick={() => handleRowClick(project)}
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <FolderIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{project.name}</span>
                </div>
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <PriorityBadge priority={project.priority} />
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <UserSelectPopover
                  onSelect={(user) => handleOwnerChange(project.id, user)}
                  placeholder="Assign owner"
                  trigger={
                    project.owner ? (
                      <button
                        className="-mx-1 flex items-center gap-2 rounded px-1 hover:bg-muted/50"
                        type="button"
                      >
                        <Avatar className="h-6 w-6">
                          {project.owner.avatarUrl ? (
                            <AvatarImage
                              alt={getUserDisplayName(project.owner)}
                              src={project.owner.avatarUrl}
                            />
                          ) : null}
                          <AvatarFallback className="text-[10px]">
                            {getUserInitials(
                              project.owner.firstName,
                              project.owner.lastName
                            )}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm">
                          {getUserDisplayName(project.owner)}
                        </span>
                      </button>
                    ) : (
                      <button
                        className="-mx-1 flex items-center gap-2 rounded px-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        type="button"
                      >
                        <UserIcon className="h-4 w-4" />
                        <span className="text-sm">Unassigned</span>
                      </button>
                    )
                  }
                  users={orgUsers}
                  value={
                    project.owner
                      ? {
                          id: project.owner.id,
                          name: getUserDisplayName(project.owner),
                          avatarUrl: project.owner.avatarUrl ?? undefined,
                          initials: getUserInitials(
                            project.owner.firstName,
                            project.owner.lastName
                          ),
                        }
                      : null
                  }
                />
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                {project.targetDate ? (
                  <DatePickerPopover
                    fromDate={new Date()}
                    onSelect={(date) => handleDateChange(project.id, date)}
                    trigger={
                      <button className="text-sm hover:underline" type="button">
                        {formatDateCompact(project.targetDate)}
                      </button>
                    }
                    value={ensureDate(project.targetDate)}
                  />
                ) : (
                  <DatePickerPopover
                    fromDate={new Date()}
                    iconOnly
                    onSelect={(date) => handleDateChange(project.id, date)}
                    placeholder="Set target date"
                    value={null}
                  />
                )}
              </TableCell>
              <TableCell>
                <HexagonProgress value={project.status} />
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button className="h-8 w-8" size="icon" variant="ghost">
                      <MoreHorizontalIcon className="h-4 w-4" />
                      <span className="sr-only">Open menu</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                      onClick={() => deleteConfirmation.requestDelete(project)}
                    >
                      <TrashIcon className="mr-2 h-4 w-4" />
                      Delete project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <DeleteConfirmationDialog
        isPending={deleteConfirmation.isPending}
        itemName={deleteConfirmation.itemToDelete?.name ?? ""}
        onConfirm={deleteConfirmation.confirmDelete}
        onOpenChange={deleteConfirmation.setOpen}
        open={deleteConfirmation.isOpen}
        title="Project"
      />
    </div>
  );
}
