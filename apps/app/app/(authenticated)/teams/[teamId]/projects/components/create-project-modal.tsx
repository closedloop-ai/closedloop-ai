"use client";

import { Priority } from "@repo/api/src/types/common";
import type { CreateProjectInput } from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
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
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { useTeamMembers } from "@/hooks/use-team-members";
import { PRIORITY_LABELS } from "@/lib/project-constants";

type CreateProjectModalProps = {
  teamId: string;
  teamName: string;
  onCreateProject?: (project: CreateProjectInput) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function CreateProjectModal({
  teamId,
  teamName,
  onCreateProject,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
}: CreateProjectModalProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = externalOpen ?? internalOpen;
  const setOpen = externalOnOpenChange ?? setInternalOpen;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>(Priority.Medium);
  const [assignee, setAssignee] = useState<{
    id: string;
    name: string;
    avatarUrl?: string;
  } | null>(null);
  const [assigneeInitialized, setAssigneeInitialized] = useState(false);
  const [targetDate, setTargetDate] = useState<Date | null>(null);

  const { data: currentUser } = useCurrentUser({ enabled: open });

  // Memoize teamIds to avoid unnecessary re-fetches
  const teamIds = useMemo(() => [teamId], [teamId]);
  const { members: teamMembers } = useTeamMembers({ teamIds, enabled: open });

  // Default owner to current user when dialog opens
  useEffect(() => {
    if (open && !assigneeInitialized && currentUser) {
      const name = [currentUser.firstName, currentUser.lastName]
        .filter(Boolean)
        .join(" ");
      setAssignee({
        id: currentUser.id,
        name: name || currentUser.email,
        avatarUrl: currentUser.avatarUrl ?? undefined,
      });
      setAssigneeInitialized(true);
    }
    if (!open) {
      setAssigneeInitialized(false);
    }
  }, [open, assigneeInitialized, currentUser]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      return;
    }

    const projectData: CreateProjectInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      priority,
      assigneeId: assignee?.id,
      targetDate,
      teamIds: [teamId],
    };

    onCreateProject?.(projectData);
    handleClose();
  };

  const handleClose = () => {
    setOpen(false);
    // Reset form
    setName("");
    setDescription("");
    setPriority(Priority.Medium);
    setAssignee(null);
    setTargetDate(null);
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          Add Project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>
              Create a new project in {teamName}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Project Name</Label>
              <Input
                id="name"
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter project name"
                required
                value={name}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Enter project description (optional)"
                rows={3}
                value={description}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="priority">Priority</Label>
                <Select
                  onValueChange={(v) => setPriority(v as Priority)}
                  value={priority}
                >
                  <SelectTrigger id="priority">
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        <span className="inline-flex items-center gap-1.5">
                          <PriorityIcon priority={value as Priority} />
                          {label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Target Date</Label>
                <DatePickerPopover
                  className="w-full"
                  fromDate={new Date()}
                  onSelect={setTargetDate}
                  placeholder="Select date"
                  value={targetDate}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Assignee</Label>
              <UserSelectPopover
                onSelect={setAssignee}
                placeholder="Select assignee (optional)"
                users={teamMembers}
                value={assignee}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!name.trim()} type="submit">
              Create Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
