"use client";

import {
  EntityType,
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
  entity?: MovableEntity;
  entities?: MovableEntity[];
  teamId?: string | null;
  currentProjectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
};

export function MoveEntityDialog({
  entity,
  entities,
  teamId,
  currentProjectId,
  open,
  onOpenChange,
  onSuccess,
}: Readonly<MoveEntityDialogProps>) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isBulkMoving, setIsBulkMoving] = useState(false);

  let entitiesToMove: MovableEntity[] = [];
  if (entities?.length) {
    entitiesToMove = entities;
  } else if (entity) {
    entitiesToMove = [entity];
  }
  const isBulkMove = entitiesToMove.length > 1;
  const primaryEntity = entitiesToMove[0];
  // Any entity that can have downstream children (Artifact, Feature, Plan, etc.) is a parent.
  // ExternalLink is a leaf — it cannot produce downstream entities.
  const isParentEntity = primaryEntity?.entityType !== EntityType.ExternalLink;

  const { data: projects = [] } = useProjects(teamId ?? undefined);
  const batchMove = useBatchMoveEntities();

  const { data: downstreamEntities = [], isLoading: isLoadingDownstream } =
    useLinkedEntities(
      primaryEntity?.id ?? "",
      primaryEntity?.entityType ?? EntityType.Artifact,
      {
        direction: LinkDirection.Target,
        linkType: LinkType.Produces,
        mode: LinkQueryMode.Tree,
        enabled: open && !isBulkMove && !!primaryEntity && !isParentEntity,
      }
    );

  const entityProjectId = primaryEntity?.projectId ?? currentProjectId;
  const availableProjects = projects.filter((p) => p.id !== entityProjectId);
  const isMovePending = batchMove.isPending || isBulkMoving;

  const handleMoveClick = () => {
    if (!primaryEntity) {
      return;
    }
    if (isBulkMove) {
      executeBulkMove(isParentEntity).catch(() => undefined);
      return;
    }
    if (isParentEntity) {
      executeSingleMove(true);
      return;
    }
    if (downstreamEntities.length > 0) {
      setShowConfirmation(true);
    } else {
      executeSingleMove(false);
    }
  };

  const executeSingleMove = (includeDownstream: boolean) => {
    if (!primaryEntity) {
      return;
    }
    batchMove.mutate(
      {
        entityId: primaryEntity.id,
        entityType: primaryEntity.entityType,
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

  const executeBulkMove = async (includeDownstream: boolean) => {
    if (!(selectedProjectId && entitiesToMove.length > 0)) {
      return;
    }
    setIsBulkMoving(true);
    try {
      const results = await Promise.allSettled(
        entitiesToMove.map((item) =>
          batchMove.mutateAsync({
            entityId: item.id,
            entityType: item.entityType,
            targetProjectId: selectedProjectId,
            includeDownstream,
          })
        )
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;
      if (failed === 0) {
        toast.success(`Moved ${succeeded} items successfully`);
      } else if (succeeded > 0) {
        toast.warning(
          `Moved ${succeeded} of ${results.length} items. ${failed} failed.`
        );
      } else {
        return;
      }
      setShowConfirmation(false);
      setSelectedProjectId("");
      onOpenChange(false);
      onSuccess?.();
    } catch {
      /* global onError handles toast */
    } finally {
      setIsBulkMoving(false);
    }
  };

  const handleConfirm = (moveAll: boolean) => {
    if (isBulkMove) {
      executeBulkMove(moveAll).catch(() => undefined);
      return;
    }
    executeSingleMove(moveAll);
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
              Select the project you want to move{" "}
              {isBulkMove ? "these items" : "this item"} to.
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
              disabled={isMovePending}
              onClick={() => onOpenChange(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                !selectedProjectId ||
                availableProjects.length === 0 ||
                isMovePending ||
                (!(isBulkMove || isParentEntity) && isLoadingDownstream)
              }
              onClick={handleMoveClick}
            >
              {isMovePending ? (
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
      {!(isBulkMove || isParentEntity) && (
        <MoveDownstreamConfirmationDialog
          downstreamEntities={downstreamEntities}
          onConfirm={handleConfirm}
          onOpenChange={setShowConfirmation}
          open={showConfirmation}
        />
      )}
    </>
  );
}
