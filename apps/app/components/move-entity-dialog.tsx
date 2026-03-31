"use client";

import type { EntityType } from "@repo/api/src/types/entity-link";
import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
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
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import {
  useBatchMoveEntities,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { useProjects } from "@/hooks/queries/use-projects";
import { MoveDownstreamConfirmationDialog } from "./move-downstream-confirmation-dialog";

type MovableEntity = {
  id: string;
  entityType: EntityType;
  projectId?: string | null;
};

type MoveEntityDialogProps = {
  entity: MovableEntity;
  teamId?: string | null;
  currentProjectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
};

export function MoveEntityDialog({
  entity,
  teamId,
  currentProjectId,
  open,
  onOpenChange,
  onSuccess,
}: Readonly<MoveEntityDialogProps>) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [showConfirmation, setShowConfirmation] = useState(false);

  const { data: projects = [] } = useProjects(teamId ?? undefined);
  const batchMove = useBatchMoveEntities();

  const { data: downstreamEntities = [], isLoading: isLoadingDownstream } =
    useLinkedEntities(entity.id, entity.entityType, {
      direction: LinkDirection.Target,
      linkType: LinkType.Produces,
      mode: LinkQueryMode.Tree,
      enabled: open,
    });

  const entityProjectId = entity.projectId ?? currentProjectId;
  const availableProjects = projects.filter((p) => p.id !== entityProjectId);

  const handleMoveClick = () => {
    if (downstreamEntities.length > 0) {
      setShowConfirmation(true);
    } else {
      executeBatchMove(false);
    }
  };

  const executeBatchMove = (includeDownstream: boolean) => {
    batchMove.mutate(
      {
        entityId: entity.id,
        entityType: entity.entityType,
        targetProjectId: selectedProjectId,
        includeDownstream,
      },
      {
        onSuccess: () => {
          toast.success(
            includeDownstream
              ? "Moved with all downstream items"
              : "Moved successfully"
          );
          setShowConfirmation(false);
          setSelectedProjectId("");
          onOpenChange(false);
          onSuccess?.();
        },
      }
    );
  };

  const handleConfirm = (moveAll: boolean) => {
    executeBatchMove(moveAll);
  };

  return (
    <>
      <Dialog
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSelectedProjectId("");
            setShowConfirmation(false);
          }
          onOpenChange(nextOpen);
        }}
        open={open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to Project</DialogTitle>
            <DialogDescription>
              Select the project where you want to move this item.
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
              disabled={batchMove.isPending}
              onClick={() => onOpenChange(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                !selectedProjectId ||
                availableProjects.length === 0 ||
                batchMove.isPending ||
                isLoadingDownstream
              }
              onClick={handleMoveClick}
            >
              {batchMove.isPending ? (
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
      <MoveDownstreamConfirmationDialog
        downstreamEntities={downstreamEntities}
        onConfirm={handleConfirm}
        onOpenChange={setShowConfirmation}
        open={showConfirmation}
      />
    </>
  );
}
