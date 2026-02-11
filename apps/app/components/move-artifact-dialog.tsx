"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { artifactKeys, useUpdateArtifact } from "@/hooks/queries/use-artifacts";
import { projectKeys, useProjects } from "@/hooks/queries/use-projects";

/**
 * Minimal artifact shape required for the move dialog.
 * Only needs id for the move operation.
 */
type MovableArtifact = {
  id: string;
  projectId?: string | null;
};

type MoveArtifactDialogProps = {
  artifact: MovableArtifact;
  /** Current project ID - can be passed explicitly when artifact doesn't include it */
  currentProjectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MoveArtifactDialog({
  artifact,
  currentProjectId,
  open,
  onOpenChange,
}: Readonly<MoveArtifactDialogProps>) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const { data: projects = [] } = useProjects();
  const updateArtifact = useUpdateArtifact();
  const queryClient = useQueryClient();

  // Use projectId from artifact if available, otherwise use the explicit prop
  const artifactProjectId = artifact.projectId ?? currentProjectId;

  const availableProjects = projects.filter((p) => p.id !== artifactProjectId);

  const handleMove = async () => {
    try {
      await updateArtifact.mutateAsync({
        id: artifact.id,
        projectId: selectedProjectId,
      });

      // Comprehensive cache invalidation
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: artifactKeys.detail(artifact.id),
        }),
        artifactProjectId
          ? queryClient.invalidateQueries({
              queryKey: artifactKeys.list({ projectId: artifactProjectId }),
            })
          : Promise.resolve(),
        queryClient.invalidateQueries({
          queryKey: artifactKeys.list({ projectId: selectedProjectId }),
        }),
        artifactProjectId
          ? queryClient.invalidateQueries({
              queryKey: projectKeys.detail(artifactProjectId),
            })
          : Promise.resolve(),
        queryClient.invalidateQueries({
          queryKey: projectKeys.detail(selectedProjectId),
        }),
        queryClient.invalidateQueries({ queryKey: projectKeys.all }),
      ]);

      toast.success("Artifact moved successfully");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to move artifact", {
        description: "Please try again.",
      });
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to Project</DialogTitle>
          <DialogDescription>
            Select the project where you want to move this artifact.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-select">Select project</Label>
            <Select
              onValueChange={setSelectedProjectId}
              value={selectedProjectId}
            >
              <SelectTrigger
                aria-label="Select destination project"
                id="project-select"
              >
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {availableProjects.length === 0 ? (
                  <SelectItem disabled value="no-projects">
                    No available projects
                  </SelectItem>
                ) : (
                  availableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={updateArtifact.isPending}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={
              !selectedProjectId ||
              availableProjects.length === 0 ||
              updateArtifact.isPending
            }
            onClick={handleMove}
          >
            {updateArtifact.isPending ? (
              <>
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Moving...
              </>
            ) : (
              "Move"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
