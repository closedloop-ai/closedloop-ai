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
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeamMembers,
  removeTeamMember,
  updateTeam,
  updateTeamMemberRole,
} from "@/app/actions/teams";
import { getOrganizationUsers } from "@/app/actions/users";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Members state
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [orgUsers, setOrgUsers] = useState<User[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);

  // For adding new members
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<TeamRole>("MEMBER");
  const [addingMember, setAddingMember] = useState(false);

  // Pending members for create mode (not yet saved)
  const [pendingMembers, setPendingMembers] = useState<
    Array<{ user: User; role: TeamRole }>
  >([]);

  // Delete team state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const loadOrgUsers = useCallback(async () => {
    setLoadingUsers(true);
    const result = await getOrganizationUsers();
    if (result.success) {
      setOrgUsers(result.data);
    } else {
      console.error("Failed to load organization users:", result.error);
    }
    setLoadingUsers(false);
  }, []);

  const loadMembers = useCallback(async (teamId: string) => {
    setLoadingMembers(true);
    const result = await getTeamMembers(teamId);
    if (result.success) {
      setMembers(result.data);
    }
    setLoadingMembers(false);
  }, []);

  // Load data when modal opens
  useEffect(() => {
    if (open) {
      setName(team?.name || "");
      setError(null);
      loadOrgUsers();

      if (isEditMode && team) {
        loadMembers(team.id);
      } else {
        setMembers([]);
        setPendingMembers([]);
      }
    }
  }, [open, team, isEditMode, loadMembers, loadOrgUsers]);

  // Get users that are not already members
  const availableUsers = useMemo(() => {
    const memberUserIds = new Set(members.map((m) => m.userId));
    const pendingUserIds = new Set(pendingMembers.map((m) => m.user.id));
    return orgUsers.filter(
      (u) => !(memberUserIds.has(u.id) || pendingUserIds.has(u.id))
    );
  }, [orgUsers, members, pendingMembers]);

  const handleAddMember = async () => {
    if (!selectedUserId) {
      return;
    }

    const user = orgUsers.find((u) => u.id === selectedUserId);
    if (!user) {
      return;
    }

    if (isEditMode && team) {
      // In edit mode, add directly via API
      setAddingMember(true);
      const result = await addTeamMember(team.id, selectedUserId, selectedRole);
      if (result.success) {
        setMembers((prev) => [...prev, result.data]);
      } else {
        setError(result.error || "Failed to add member");
      }
      setAddingMember(false);
    } else {
      // In create mode, add to pending list
      setPendingMembers((prev) => [...prev, { user, role: selectedRole }]);
    }

    setSelectedUserId("");
    setSelectedRole("MEMBER");
  };

  const handleRemoveMember = async (member: TeamMember) => {
    if (!team) {
      return;
    }

    const result = await removeTeamMember(team.id, member.userId);
    if (result.success) {
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } else {
      setError(result.error || "Failed to remove member");
    }
  };

  const handleRemovePendingMember = (userId: string) => {
    setPendingMembers((prev) => prev.filter((m) => m.user.id !== userId));
  };

  const handleRoleChange = async (member: TeamMember, newRole: TeamRole) => {
    if (!team) {
      return;
    }

    const result = await updateTeamMemberRole(team.id, member.userId, newRole);
    if (result.success) {
      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m))
      );
    } else {
      setError(result.error || "Failed to update role");
    }
  };

  const handlePendingRoleChange = (userId: string, newRole: TeamRole) => {
    setPendingMembers((prev) =>
      prev.map((m) => (m.user.id === userId ? { ...m, role: newRole } : m))
    );
  };

  const submitUpdate = async (teamId: string): Promise<boolean> => {
    const result = await updateTeam(teamId, { name: name.trim() });
    if (!result.success) {
      setError(result.error || "Failed to update team");
      return false;
    }
    return true;
  };

  const submitCreate = async (): Promise<boolean> => {
    const result = await createTeam({ name: name.trim() });
    if (!result.success) {
      setError(result.error || "Failed to create team");
      return false;
    }
    for (const pending of pendingMembers) {
      await addTeamMember(result.data.id, pending.user.id, pending.role);
    }
    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const success =
      isEditMode && team ? await submitUpdate(team.id) : await submitCreate();

    if (success) {
      handleClose();
      onSuccess?.();
    }

    setIsSubmitting(false);
  };

  const handleClose = () => {
    setOpen(false);
    setName("");
    setError(null);
    setMembers([]);
    setPendingMembers([]);
    setSelectedUserId("");
    setSelectedRole("MEMBER");
  };

  const handleDeleteTeam = async () => {
    if (!team) {
      return;
    }

    setIsDeleting(true);
    const result = await deleteTeam(team.id);
    if (result.success) {
      setShowDeleteDialog(false);
      handleClose();
      onSuccess?.();
    } else {
      setError(result.error || "Failed to delete team");
    }
    setIsDeleting(false);
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
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
