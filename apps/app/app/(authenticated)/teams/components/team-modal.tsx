"use client";

import type { TeamWithCounts } from "@repo/api/src/types/teams";
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
import { PlusIcon, TrashIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { TeamModalBody } from "./team-modal-body";
import { useTeamModal } from "./use-team-modal";

type TeamModalProps = {
  trigger?: ReactNode;
  team?: TeamWithCounts;
  onSuccess?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// Outer shell. Owns the open/close state only — all form state lives in
// TeamModalContent, which is mounted only while the dialog is open. Closing
// the dialog unmounts the content, so re-opening it always starts from a
// clean slate without imperative reset effects.
export function TeamModal({
  trigger,
  team,
  onSuccess,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: TeamModalProps) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;

  const handleOpenChange = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    controlledOnOpenChange?.(next);
  };

  const handleClose = () => handleOpenChange(false);

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
      {open ? (
        <TeamModalContent
          onClose={handleClose}
          onSuccess={onSuccess}
          team={team}
        />
      ) : null}
    </Dialog>
  );
}

type TeamModalContentProps = {
  team?: TeamWithCounts;
  onSuccess?: () => void;
  onClose: () => void;
};

function TeamModalContent({ team, onSuccess, onClose }: TeamModalContentProps) {
  const state = useTeamModal({ team, onSuccess, onClose });

  const {
    disableSubmit,
    handleClose,
    handleDeleteTeam,
    handleSubmit,
    isDeleting,
    isEditMode,
    isSubmitting,
    setShowDeleteDialog,
    showDeleteDialog,
    showRepositoriesTab,
  } = state;

  return (
    <>
      <DialogContent
        className={`flex max-h-[80vh] min-h-[500px] flex-col overflow-y-auto ${
          showRepositoriesTab ? "sm:max-w-[640px]" : "sm:max-w-[500px]"
        }`}
      >
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={handleSubmit}
        >
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

          <TeamModalBody state={state} />

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
    </>
  );
}

function getSubmitButtonText(
  isSubmitting: boolean,
  isEditMode: boolean
): string {
  if (isSubmitting) {
    return isEditMode ? "Saving..." : "Creating...";
  }
  return isEditMode ? "Save Changes" : "Create Team";
}
