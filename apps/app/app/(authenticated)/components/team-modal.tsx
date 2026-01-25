"use client";

import type { User } from "@repo/api/src/types/organization";
import type {
  TeamMember,
  TeamRole,
  TeamWithCounts,
} from "@repo/api/src/types/teams";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Separator } from "@repo/design-system/components/ui/separator";
import { LoaderIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useTeamMembers,
  useUpdateTeam,
  useUpdateTeamMemberRole,
} from "@/hooks/queries/use-teams";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

type TeamModalProps = {
  trigger?: ReactNode;
  team?: TeamWithCounts;
  onSuccess?: () => void;
};

function getSubmitButtonText(
  isSubmitting: boolean,
  isEditMode: boolean
): string {
  if (isSubmitting) {
    return isEditMode ? "Saving..." : "Creating...";
  }
  return isEditMode ? "Save Changes" : "Create Team";
}

function UserSelectContent({
  loading,
  users,
}: {
  loading: boolean;
  users: User[];
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (users.length === 0) {
    return (
      <div className="p-2 text-center text-muted-foreground text-sm">
        No users available
      </div>
    );
  }
  return (
    <>
      {users.map((user) => (
        <SelectItem key={user.id} value={user.id}>
          <div className="flex items-center gap-2">
            <Avatar className="h-5 w-5">
              {user.avatarUrl ? <AvatarImage src={user.avatarUrl} /> : null}
              <AvatarFallback className="text-[10px]">
                {getUserInitials(user.firstName, user.lastName)}
              </AvatarFallback>
            </Avatar>
            <span>{getUserDisplayName(user)}</span>
          </div>
        </SelectItem>
      ))}
    </>
  );
}

export function TeamModal({ trigger, team, onSuccess }: TeamModalProps) {
  const isEditMode = !!team;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team?.name || "");
  const [error, setError] = useState<string | null>(null);

  // For adding new members
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<TeamRole>("MEMBER");

  // Pending members for create mode (not yet saved)
  const [pendingMembers, setPendingMembers] = useState<
    Array<{ user: User; role: TeamRole }>
  >([]);

  // Delete team state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Queries - only fetch when modal is open
  const { data: usersResult, isLoading: loadingUsers } = useOrganizationUsers({
    enabled: open,
  });
  const orgUsers = usersResult?.success ? usersResult.data : [];

  const { data: membersResult, isLoading: loadingMembers } = useTeamMembers(
    team?.id ?? "",
    { enabled: open && isEditMode && !!team?.id }
  );
  const members = membersResult?.success ? membersResult.data : [];

  // Mutations
  const createTeamMutation = useCreateTeam();
  const updateTeamMutation = useUpdateTeam();
  const deleteTeamMutation = useDeleteTeam();
  const addMemberMutation = useAddTeamMember();
  const removeMemberMutation = useRemoveTeamMember();
  const updateRoleMutation = useUpdateTeamMemberRole();

  // Get users that are not already members
  const availableUsers = useMemo(() => {
    const memberUserIds = new Set(members.map((m) => m.userId));
    const pendingUserIds = new Set(pendingMembers.map((m) => m.user.id));
    return orgUsers.filter(
      (u) => !(memberUserIds.has(u.id) || pendingUserIds.has(u.id))
    );
  }, [orgUsers, members, pendingMembers]);

  const handleAddMember = () => {
    if (!selectedUserId) {
      return;
    }

    const user = orgUsers.find((u) => u.id === selectedUserId);
    if (!user) {
      return;
    }

    if (isEditMode && team) {
      // In edit mode, add directly via API
      addMemberMutation.mutate(
        { teamId: team.id, userId: selectedUserId, role: selectedRole },
        {
          onError: () => {
            setError("Failed to add member");
          },
        }
      );
    } else {
      // In create mode, add to pending list
      setPendingMembers((prev) => [...prev, { user, role: selectedRole }]);
    }

    setSelectedUserId("");
    setSelectedRole("MEMBER");
  };

  const handleRemoveMember = (member: TeamMember) => {
    if (!team) {
      return;
    }

    removeMemberMutation.mutate(
      { teamId: team.id, userId: member.userId },
      {
        onError: () => {
          setError("Failed to remove member");
        },
      }
    );
  };

  const handleRemovePendingMember = (userId: string) => {
    setPendingMembers((prev) => prev.filter((m) => m.user.id !== userId));
  };

  const handleRoleChange = (member: TeamMember, newRole: TeamRole) => {
    if (!team) {
      return;
    }

    updateRoleMutation.mutate(
      { teamId: team.id, userId: member.userId, role: newRole },
      {
        onError: () => {
          setError("Failed to update role");
        },
      }
    );
  };

  const handlePendingRoleChange = (userId: string, newRole: TeamRole) => {
    setPendingMembers((prev) =>
      prev.map((m) => (m.user.id === userId ? { ...m, role: newRole } : m))
    );
  };

  const handleClose = () => {
    setOpen(false);
    setName("");
    setError(null);
    setPendingMembers([]);
    setSelectedUserId("");
    setSelectedRole("MEMBER");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }

    setError(null);

    if (isEditMode && team) {
      // Update existing team
      updateTeamMutation.mutate(
        { id: team.id, input: { name: name.trim() } },
        {
          onSuccess: (result) => {
            if (!result.success) {
              setError(result.error || "Failed to update team");
              return;
            }
            handleClose();
            onSuccess?.();
          },
          onError: () => {
            setError("Failed to update team");
          },
        }
      );
    } else {
      // Create new team
      createTeamMutation.mutate(
        { name: name.trim() },
        {
          onSuccess: async (result) => {
            if (!result.success) {
              setError(result.error || "Failed to create team");
              return;
            }
            // Add pending members
            for (const pending of pendingMembers) {
              await addMemberMutation.mutateAsync({
                teamId: result.data.id,
                userId: pending.user.id,
                role: pending.role,
              });
            }
            handleClose();
            onSuccess?.();
          },
          onError: () => {
            setError("Failed to create team");
          },
        }
      );
    }
  };

  const handleDeleteTeam = () => {
    if (!team) {
      return;
    }

    deleteTeamMutation.mutate(team.id, {
      onSuccess: (result) => {
        if (result.success) {
          setShowDeleteDialog(false);
          handleClose();
          onSuccess?.();
        } else {
          setError(result.error || "Failed to delete team");
        }
      },
      onError: () => {
        setError("Failed to delete team");
      },
    });
  };

  const isSubmitting =
    createTeamMutation.isPending || updateTeamMutation.isPending;
  const isDeleting = deleteTeamMutation.isPending;
  const addingMember = addMemberMutation.isPending;

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (newOpen) {
      // Reset form state when opening
      setName(team?.name || "");
      setError(null);
      setPendingMembers([]);
      setSelectedUserId("");
      setSelectedRole("MEMBER");
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        {trigger || (
          <Button>
            <PlusIcon className="mr-2 h-4 w-4" />
            Create Team
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditMode ? "Edit Team" : "Create Team"}
            </DialogTitle>
            <DialogDescription>
              {isEditMode
                ? "Update team settings and manage members."
                : "Create a new team and add members."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Team Name */}
            <div className="grid gap-2">
              <Label htmlFor="team-name">Team Name</Label>
              <Input
                autoFocus
                id="team-name"
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Engineering, Design, Product"
                required
                value={name}
              />
            </div>

            <Separator />

            {/* Members Section */}
            <div className="grid gap-3">
              <Label>Team Members</Label>

              {/* Add Member Row */}
              <div className="flex gap-2">
                <Select
                  onValueChange={setSelectedUserId}
                  value={selectedUserId}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select a user to add..." />
                  </SelectTrigger>
                  <SelectContent>
                    <UserSelectContent
                      loading={loadingUsers}
                      users={availableUsers}
                    />
                  </SelectContent>
                </Select>

                <Select
                  onValueChange={(v) => setSelectedRole(v as TeamRole)}
                  value={selectedRole}
                >
                  <SelectTrigger className="w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEMBER">Member</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    <SelectItem value="OWNER">Owner</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  disabled={!selectedUserId || addingMember}
                  onClick={handleAddMember}
                  size="icon"
                  type="button"
                  variant="outline"
                >
                  {addingMember ? (
                    <LoaderIcon className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlusIcon className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {/* Members List */}
              <div className="max-h-[200px] space-y-2 overflow-y-auto">
                {loadingMembers ? (
                  <div className="flex items-center justify-center py-4">
                    <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <>
                    {/* Existing members (edit mode) */}
                    {members.map((member) => (
                      <div
                        className="flex items-center justify-between rounded-md border p-2"
                        key={member.id}
                      >
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            {member.user.avatarUrl ? (
                              <AvatarImage src={member.user.avatarUrl} />
                            ) : null}
                            <AvatarFallback className="text-xs">
                              {getUserInitials(
                                member.user.firstName,
                                member.user.lastName
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col">
                            <span className="text-sm">
                              {getUserDisplayName(member.user)}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {member.user.email}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Select
                            onValueChange={(v) =>
                              handleRoleChange(member, v as TeamRole)
                            }
                            value={member.role}
                          >
                            <SelectTrigger className="h-7 w-[90px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="MEMBER">Member</SelectItem>
                              <SelectItem value="ADMIN">Admin</SelectItem>
                              <SelectItem value="OWNER">Owner</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => handleRemoveMember(member)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}

                    {/* Pending members (create mode) */}
                    {pendingMembers.map((pending) => (
                      <div
                        className="flex items-center justify-between rounded-md border border-dashed p-2"
                        key={pending.user.id}
                      >
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            {pending.user.avatarUrl ? (
                              <AvatarImage src={pending.user.avatarUrl} />
                            ) : null}
                            <AvatarFallback className="text-xs">
                              {getUserInitials(
                                pending.user.firstName,
                                pending.user.lastName
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col">
                            <span className="text-sm">
                              {getUserDisplayName(pending.user)}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {pending.user.email}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Select
                            onValueChange={(v) =>
                              handlePendingRoleChange(
                                pending.user.id,
                                v as TeamRole
                              )
                            }
                            value={pending.role}
                          >
                            <SelectTrigger className="h-7 w-[90px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="MEMBER">Member</SelectItem>
                              <SelectItem value="ADMIN">Admin</SelectItem>
                              <SelectItem value="OWNER">Owner</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() =>
                              handleRemovePendingMember(pending.user.id)
                            }
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <XIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}

                    {members.length === 0 && pendingMembers.length === 0 && (
                      <p className="py-2 text-center text-muted-foreground text-sm">
                        No members yet. Add members above.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {error ? (
              <p className="rounded-md border border-destructive/20 bg-destructive/10 p-2 text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            {isEditMode ? (
              <Button
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setShowDeleteDialog(true)}
                type="button"
                variant="ghost"
              >
                <TrashIcon className="mr-2 h-4 w-4" />
                Delete Team
              </Button>
            ) : null}
            <div className="flex gap-2">
              <Button onClick={handleClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={!name.trim() || isSubmitting} type="submit">
                {getSubmitButtonText(isSubmitting, isEditMode)}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>

      <DeleteConfirmationDialog
        isPending={isDeleting}
        itemName={team?.name ?? ""}
        onConfirm={handleDeleteTeam}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="Team"
      />
    </Dialog>
  );
}
