"use client";

import { DocumentType } from "@repo/api/src/types/document";
import { useCallback, useState } from "react";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";

type EditableDocumentType =
  | typeof DocumentType.Prd
  | typeof DocumentType.ImplementationPlan;

type UseArtifactUIStateConfig<
  T extends EditableDocumentType = EditableDocumentType,
> = {
  documentType: T;
};

type CommonState = {
  showMetadataPanel: boolean;
  setShowMetadataPanel: (value: boolean | ((prev: boolean) => boolean)) => void;
  toggleMetadataPanel: () => void;
  showDeleteDialog: boolean;
  setShowDeleteDialog: React.Dispatch<React.SetStateAction<boolean>>;
  openDeleteDialog: () => void;
  closeDeleteDialog: () => void;
};

type PrdState = CommonState & {
  showRenameDialog: boolean;
  setShowRenameDialog: React.Dispatch<React.SetStateAction<boolean>>;
  openRenameDialog: () => void;
  closeRenameDialog: () => void;
  showGeneratePlanModal: boolean;
  setShowGeneratePlanModal: React.Dispatch<React.SetStateAction<boolean>>;
  openGeneratePlanModal: () => void;
  closeGeneratePlanModal: () => void;
  showRequestChangesModal: boolean;
  setShowRequestChangesModal: React.Dispatch<React.SetStateAction<boolean>>;
  openRequestChangesModal: () => void;
  closeRequestChangesModal: () => void;
};

type PlanState = CommonState & {
  showRequestChangesModal: boolean;
  setShowRequestChangesModal: React.Dispatch<React.SetStateAction<boolean>>;
  openRequestChangesModal: () => void;
  closeRequestChangesModal: () => void;
  showLinearExportDialog: boolean;
  setShowLinearExportDialog: React.Dispatch<React.SetStateAction<boolean>>;
  openLinearExportDialog: () => void;
  closeLinearExportDialog: () => void;
  showExecuteModal: boolean;
  setShowExecuteModal: React.Dispatch<React.SetStateAction<boolean>>;
  openExecuteModal: () => void;
  closeExecuteModal: () => void;
};

/**
 * Hook to manage UI state for artifact editors (modal and panel visibility).
 *
 * **Use this hook when:** Your component needs to control visibility of modals, dialogs, or panels.
 *
 * **What it provides:**
 * - Common UI state (metadata panel, delete dialog)
 * - PRD-specific UI state (rename dialog, generate plan modal)
 * - Plan-specific UI state (request changes modal, Linear export dialog, execute modal)
 * - Type-safe return values based on artifact type
 * - Helper functions to open/close/toggle each UI element
 *
 * **Example usage:**
 * ```tsx
 * // For PRD editor
 * const { showMetadataPanel, toggleMetadataPanel, showRenameDialog, openRenameDialog } =
 *   useDocumentUIState({ documentType: "PRD" });
 *
 * // For Plan editor
 * const { showExecuteModal, openExecuteModal, closeExecuteModal } =
 *   useDocumentUIState({ documentType: "IMPLEMENTATION_PLAN" });
 * ```
 *
 * **Important:** Return type is determined by `documentType` - PRD returns PRD-specific state, Plan returns Plan-specific state.
 */
export function useDocumentUIState(
  config: UseArtifactUIStateConfig<typeof DocumentType.Prd>
): PrdState;
export function useDocumentUIState(
  config: UseArtifactUIStateConfig<typeof DocumentType.ImplementationPlan>
): PlanState;
export function useDocumentUIState(config: UseArtifactUIStateConfig) {
  const { documentType } = config;

  // Common UI state
  const [showMetadataPanel, setShowMetadataPanel] = useLocalStorageState(
    `panel:chat:${documentType}`,
    true
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // PRD-specific UI state
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showGeneratePlanModal, setShowGeneratePlanModal] = useState(false);

  // Plan-specific UI state
  const [showRequestChangesModal, setShowRequestChangesModal] = useState(false);
  const [showLinearExportDialog, setShowLinearExportDialog] = useState(false);
  const [showExecuteModal, setShowExecuteModal] = useState(false);

  // Toggle requires useCallback since it uses the previous state
  const toggleMetadataPanel = useCallback(() => {
    setShowMetadataPanel((prev) => !prev);
  }, [setShowMetadataPanel]);

  // Common return values for all artifact types
  const commonState = {
    showMetadataPanel,
    setShowMetadataPanel,
    toggleMetadataPanel,
    showDeleteDialog,
    setShowDeleteDialog,
    openDeleteDialog: () => setShowDeleteDialog(true),
    closeDeleteDialog: () => setShowDeleteDialog(false),
  };

  if (documentType === DocumentType.Prd) {
    return {
      ...commonState,
      showRenameDialog,
      setShowRenameDialog,
      openRenameDialog: () => setShowRenameDialog(true),
      closeRenameDialog: () => setShowRenameDialog(false),
      showGeneratePlanModal,
      setShowGeneratePlanModal,
      openGeneratePlanModal: () => setShowGeneratePlanModal(true),
      closeGeneratePlanModal: () => setShowGeneratePlanModal(false),
      showRequestChangesModal,
      setShowRequestChangesModal,
      openRequestChangesModal: () => setShowRequestChangesModal(true),
      closeRequestChangesModal: () => setShowRequestChangesModal(false),
    };
  }

  if (documentType === DocumentType.ImplementationPlan) {
    return {
      ...commonState,
      showRequestChangesModal,
      setShowRequestChangesModal,
      openRequestChangesModal: () => setShowRequestChangesModal(true),
      closeRequestChangesModal: () => setShowRequestChangesModal(false),
      showLinearExportDialog,
      setShowLinearExportDialog,
      openLinearExportDialog: () => setShowLinearExportDialog(true),
      closeLinearExportDialog: () => setShowLinearExportDialog(false),
      showExecuteModal,
      setShowExecuteModal,
      openExecuteModal: () => setShowExecuteModal(true),
      closeExecuteModal: () => setShowExecuteModal(false),
    };
  }

  // Fallback - should never reach here due to TypeScript
  return commonState;
}
