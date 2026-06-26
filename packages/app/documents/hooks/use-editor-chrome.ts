"use client";

import type { DocumentType } from "@repo/api/src/types/document";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { useCallback, useState } from "react";

type UseEditorChromeConfig = {
  /**
   * Document type — used to scope the chat-panel visibility key in localStorage
   * so each editor type keeps its own preference. The key shape
   * (`panel:chat:${documentType}`) matches the legacy `useDocumentUIState` so
   * existing user preferences are preserved.
   */
  documentType: DocumentType;
};

/**
 * UI state common to all document editors:
 * - metadata/chat panel visibility (persisted per documentType)
 * - delete dialog
 * - move dialog
 *
 * Type-specific modals (rename, request changes, execute, etc.) live in
 * per-type modal hooks colocated with each editor.
 */
export function useEditorChrome({ documentType }: UseEditorChromeConfig) {
  const [showMetadataPanel, setShowMetadataPanel] = useLocalStorageState(
    `panel:chat:${documentType}`,
    true
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  const toggleMetadataPanel = useCallback(() => {
    setShowMetadataPanel((prev) => !prev);
  }, [setShowMetadataPanel]);

  const openDeleteDialog = useCallback(() => setShowDeleteDialog(true), []);
  const closeDeleteDialog = useCallback(() => setShowDeleteDialog(false), []);
  const openMoveDialog = useCallback(() => setShowMoveDialog(true), []);
  const closeMoveDialog = useCallback(() => setShowMoveDialog(false), []);

  return {
    showMetadataPanel,
    setShowMetadataPanel,
    toggleMetadataPanel,
    showDeleteDialog,
    setShowDeleteDialog,
    openDeleteDialog,
    closeDeleteDialog,
    showMoveDialog,
    setShowMoveDialog,
    openMoveDialog,
    closeMoveDialog,
  };
}
