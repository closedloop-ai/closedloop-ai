"use client";

import type { ProjectPriority } from "@repo/api/src/types/organization";
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
import { type FormEvent, useEffect, useState } from "react";
import { getTeamMembers } from "@/app/actions/teams";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

type CreateProjectInput = {
  name: string;
  description?: string;
  priority?: string;
  ownerId?: string;
  targetDate?: string;
  teamIds: string[];
};

type CreateProjectModalProps = {
  teamId: string;
  teamName: string;
  onCreateProject?: (project: CreateProjectInput) => void;
};

export function CreateProjectModal({
  teamId,
  teamName,
  onCreateProject,
}: CreateProjectModalProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<ProjectPriority>("NOT_SET");
  const [owner, setOwner] = useState<{
    id: string;
    name: string;
    avatarUrl?: string;
  } | null>(null);
  const [targetDate, setTargetDate] = useState<Date | null>(null);
  const [teamMembers, setTeamMembers] = useState<
    Array<{
      id: string;
      name: string;
      email?: string;
      avatarUrl?: string;
      initials: string;
    }>
  >([]);

  useEffect(() => {
    async function fetchTeamMembers() {
      const result = await getTeamMembers(teamId);
      if (result.success) {
        const transformed = result.data.map((member) => ({
          id: member.user.id,
          name: getUserDisplayName(member.user),
          email: member.user.email,
          avatarUrl: member.user.avatarUrl || undefined,
          initials: getUserInitials(
            member.user.firstName,
            member.user.lastName
          ),
        }));
        setTeamMembers(transformed);
      }
    }

    if (open) {
      fetchTeamMembers();
    } else {
      setTeamMembers([]);
    }
  }, [open, teamId]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      return;
    }

    const projectData: CreateProjectInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      priority,
      ownerId: owner?.id,
      targetDate: targetDate?.toISOString(),
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
    setPriority("NOT_SET");
    setOwner(null);
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
                  onValueChange={(v) => setPriority(v as ProjectPriority)}
                  value={priority}
                >
                  <SelectTrigger id="priority">
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NOT_SET">Not Set</SelectItem>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="MEDIUM">Medium</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
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
              <Label>Owner</Label>
              <UserSelectPopover
                onSelect={setOwner}
                placeholder="Select owner (optional)"
                users={teamMembers}
                value={owner}
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
