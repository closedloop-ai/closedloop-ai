"use client";

import { useCallback, useState } from "react";

type UseDeleteConfirmationOptions<T> = {
  onDelete: (id: string) => Promise<boolean>;
  getId: (item: T) => string;
};

type UseDeleteConfirmationReturn<T> = {
  /** Whether the confirmation dialog is open */
  isOpen: boolean;
  /** The item being deleted (for display in dialog) */
  itemToDelete: T | null;
  /** Whether the delete operation is in progress */
  isPending: boolean;
  /** Call this when user clicks delete button on an item */
  requestDelete: (item: T) => void;
  /** Call this when user confirms deletion in dialog */
  confirmDelete: () => Promise<boolean>;
  /** Setter for dialog open state (for dialog's onOpenChange) */
  setOpen: (open: boolean) => void;
};

/**
 * Hook for managing delete confirmation dialog state
 *
 * @example
 * ```tsx
 * const { isOpen, itemToDelete, isPending, requestDelete, confirmDelete, setOpen } =
 *   useDeleteConfirmation({
 *     onDelete: async (id) => deleteProject(id),
 *     getId: (project) => project.id,
 *   });
 *
 * // In dropdown menu:
 * <DropdownMenuItem onClick={() => requestDelete(project)}>Delete</DropdownMenuItem>
 *
 * // Dialog:
 * <DeleteConfirmationDialog
 *   open={isOpen}
 *   onOpenChange={setOpen}
 *   onConfirm={confirmDelete}
 *   isPending={isPending}
 *   itemName={itemToDelete?.name ?? ""}
 *   title="Project"
 * />
 * ```
 */
export function useDeleteConfirmation<T>({
  onDelete,
  getId,
}: UseDeleteConfirmationOptions<T>): UseDeleteConfirmationReturn<T> {
  const [isOpen, setIsOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<T | null>(null);
  const [isPending, setIsPending] = useState(false);

  const requestDelete = useCallback((item: T) => {
    setItemToDelete(item);
    setIsOpen(true);
  }, []);

  const confirmDelete = useCallback(async (): Promise<boolean> => {
    if (!itemToDelete) {
      return false;
    }

    setIsPending(true);
    try {
      const result = await onDelete(getId(itemToDelete));
      setIsOpen(false);
      setItemToDelete(null);
      return result ?? false;
    } finally {
      setIsPending(false);
    }
  }, [itemToDelete, onDelete, getId]);

  const setOpen = useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setItemToDelete(null);
    }
  }, []);

  return {
    isOpen,
    itemToDelete,
    isPending,
    requestDelete,
    confirmDelete,
    setOpen,
  };
}
