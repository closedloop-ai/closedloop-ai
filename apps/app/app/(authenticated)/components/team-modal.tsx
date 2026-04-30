"use client";

import type {
  TeamMember,
  TeamRole,
  TeamWithCounts,
} from "@repo/api/src/types/teams";
import type { User } from "@repo/api/src/types/user";
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
import { useRouter } from "next/navigation";
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
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@/hooks/queries/use-users";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

type TeamModalProps = {
  trigger?: ReactNode;
  team?: TeamWithCounts;
  onSuccess?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type PendingTeamMember = {
  user: User;
  role: TeamRole;
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

type TeamMembersSectionProps = {
  addingMember: boolean;
  availableUsers: User[];
  createModeMembers: PendingTeamMember[];
  currentUser: User | undefined;
  handleAddMember: () => void;
  handlePendingRoleChange: (userId: string, newRole: TeamRole) => void;
  handleRemoveMember: (member: TeamMember) => void;
  handleRemovePendingMember: (userId: string) => void;
  handleRoleChange: (member: TeamMember, newRole: TeamRole) => void;
  isCreateOwnerPending: boolean;
  isCurrentUserPending: boolean;
  loadingMembers: boolean;
  loadingUsers: boolean;
  members: TeamMember[];
  selectedRole: TeamRole;
  selectedUserId: string;
  setSelectedRole: (value: TeamRole) => void;
  setSelectedUserId: (value: string) => void;
};

function TeamMembersSection({
  addingMember,
  availableUsers,
  createModeMembers,
  currentUser,
  handleAddMember,
  handlePendingRoleChange,
  handleRemoveMember,
  handleRemovePendingMember,
  handleRoleChange,
  isCreateOwnerPending,
  isCurrentUserPending,
  loadingMembers,
  loadingUsers,
  members,
  selectedRole,
  selectedUserId,
  setSelectedRole,
  setSelectedUserId,
}: TeamMembersSectionProps) {
  return (
    <div className="grid gap-3">
      <Label>Team Members</Label>

      <div className="flex gap-2">
        <Select onValueChange={setSelectedUserId} value={selectedUserId}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a user to add..." />
          </SelectTrigger>
          <SelectContent>
            <UserSelectContent loading={loadingUsers} users={availableUsers} />
          </SelectContent>
        </Select>

        <Select
          onValueChange={(value) => setSelectedRole(value as TeamRole)}
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

      <div className="max-h-[200px] space-y-2 overflow-y-auto">
        {isCreateOwnerPending ? (
          <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground text-sm">
            {isCurrentUserPending ? (
              <LoaderIcon className="h-4 w-4 animate-spin" />
            ) : null}
            <span>Loading your owner membership...</span>
          </div>
        ) : null}

        {!isCreateOwnerPending && loadingMembers ? (
          <div className="flex items-center justify-center py-4">
            <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}

        {isCreateOwnerPending || loadingMembers ? null : (
          <>
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
                    onValueChange={(value) =>
                      handleRoleChange(member, value as TeamRole)
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

            {createModeMembers.map((pending) => (
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
                    disabled={pending.user.id === currentUser?.id}
                    onValueChange={(value) =>
                      handlePendingRoleChange(
                        pending.user.id,
                        value as TeamRole
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
                    disabled={pending.user.id === currentUser?.id}
                    onClick={() => handleRemovePendingMember(pending.user.id)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}

            {members.length === 0 && createModeMembers.length === 0 ? (
              <p className="py-2 text-center text-muted-foreground text-sm">
                No members yet. Add members above.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function TeamModal({
  trigger,
  team,
  onSuccess,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: TeamModalProps) {
  const router = useRouter();
  const isEditMode = !!team;

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (value: boolean) => {
    setUncontrolledOpen(value);
    controlledOnOpenChange?.(value);
  };
  const [name, setName] = useState(team?.name || "");
  const [error, setError] = useState<string | null>(null);

  // For adding new members
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<TeamRole>("MEMBER");

  // Pending members for create mode (not yet saved)
  const [pendingMembers, setPendingMembers] = useState<PendingTeamMember[]>([]);

  // Delete team state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Create mode needs the current user ready to render the default owner row.
  const { data: currentUser, isPending: isCurrentUserPending } = useCurrentUser(
    { enabled: !isEditMode || open }
  );
  const { data: orgUsers = [], isLoading: loadingUsers } = useOrganizationUsers(
    { enabled: open }
  );
  const { data: members = [], isLoading: loadingMembers } = useTeamMembers(
    team?.id ?? "",
    { enabled: open && isEditMode && !!team?.id }
  );

  // Mutations
  const createTeamMutation = useCreateTeam();
  const updateTeamMutation = useUpdateTeam();
  const deleteTeamMutation = useDeleteTeam();
  const addMemberMutation = useAddTeamMember();
  const removeMemberMutation = useRemoveTeamMember();
  const updateRoleMutation = useUpdateTeamMemberRole();

  const createModeMembers = useMemo(() => {
    if (isEditMode || !currentUser) {
      return pendingMembers;
    }

    return [
      { user: currentUser, role: "OWNER" as TeamRole },
      ...pendingMembers,
    ];
  }, [currentUser, isEditMode, pendingMembers]);

  // Get users that are not already members
  const availableUsers = useMemo(() => {
    const memberUserIds = new Set(members.map((m) => m.userId));
    const pendingUserIds = new Set(createModeMembers.map((m) => m.user.id));
    return orgUsers.filter(
      (u) => !(memberUserIds.has(u.id) || pendingUserIds.has(u.id))
    );
  }, [createModeMembers, members, orgUsers]);

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
      addMemberMutation.mutate({
        teamId: team.id,
        userId: selectedUserId,
        role: selectedRole,
      });
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

    removeMemberMutation.mutate({ teamId: team.id, userId: member.userId });
  };

  const handleRemovePendingMember = (userId: string) => {
    setPendingMembers((prev) => prev.filter((m) => m.user.id !== userId));
  };

  const handleRoleChange = (member: TeamMember, newRole: TeamRole) => {
    if (!team) {
      return;
    }

    updateRoleMutation.mutate({
      teamId: team.id,
      userId: member.userId,
      role: newRole,
    });
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
          onSuccess: () => {
            handleClose();
            onSuccess?.();
          },
        }
      );
    } else {
      // Create new team
      createTeamMutation.mutate(
        { name: name.trim() },
        {
          onSuccess: async (newTeam) => {
            await Promise.all(
              pendingMembers.map(async (pending) => {
                await addMemberMutation.mutateAsync({
                  teamId: newTeam.id,
                  userId: pending.user.id,
                  role: pending.role,
                });
              })
            );
            router.push(`/teams/${newTeam.id}/projects`);
            handleClose();
            onSuccess?.();
          },
        }
      );
    }
  };

  const handleDeleteTeam = async (): Promise<boolean> => {
    if (!team) {
      return false;
    }

    const result = await deleteTeamMutation.mutateAsync(team.id, {
      onSuccess: () => {
        setShowDeleteDialog(false);
        handleClose();
        onSuccess?.();
      },
    });
    return result.deleted ?? false;
  };

  const isSubmitting =
    createTeamMutation.isPending || updateTeamMutation.isPending;
  const isDeleting = deleteTeamMutation.isPending;
  const addingMember = addMemberMutation.isPending;
  const isCreateOwnerPending = !(isEditMode || currentUser);
  const disableSubmit = isSubmitting || !name.trim() || isCreateOwnerPending;

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

  const isControlled = controlledOpen !== undefined;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger || (
            <Button>
              <PlusIcon className="h-4 w-4" />
              Create Team
            </Button>
          )}
        </DialogTrigger>
      )}
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

            <TeamMembersSection
              addingMember={addingMember}
              availableUsers={availableUsers}
              createModeMembers={createModeMembers}
              currentUser={currentUser}
              handleAddMember={handleAddMember}
              handlePendingRoleChange={handlePendingRoleChange}
              handleRemoveMember={handleRemoveMember}
              handleRemovePendingMember={handleRemovePendingMember}
              handleRoleChange={handleRoleChange}
              isCreateOwnerPending={isCreateOwnerPending}
              isCurrentUserPending={isCurrentUserPending}
              loadingMembers={loadingMembers}
              loadingUsers={loadingUsers}
              members={members}
              selectedRole={selectedRole}
              selectedUserId={selectedUserId}
              setSelectedRole={setSelectedRole}
              setSelectedUserId={setSelectedUserId}
            />

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
                <TrashIcon className="h-4 w-4" />
                Delete Team
              </Button>
            ) : null}
            <div className="flex gap-2">
              <Button onClick={handleClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={disableSubmit} type="submit">
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
