"use client";

import { DocumentStatus } from "@repo/api/src/types/document";
import { NewDocumentModal } from "@repo/app/documents/components/new-document-modal";
import { NewDocumentModalRecoverable } from "@repo/app/documents/components/new-document-modal-recoverable";
import {
  GenericArtifactKind,
  genericArtifactStatusFromRaw,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { HeaderPrimaryAction } from "@repo/app/shared/components/header-primary-action";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DOCUMENTS_CREATE_FAILURE_RECOVERY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createContext, type ReactNode, useContext, useState } from "react";

/**
 * First-class create entry point for the org-level Documents page (FEA-4345).
 * A Document is a first-class, type-agnostic, org-level artifact — it does NOT
 * require a project — so this action is a primary "New Document" button that
 * opens the type-agnostic New Document dialog. The dialog collects a title,
 * creates the artifact project-less as a generic Document, and routes into its
 * detail page (or leaves the user on this index for a type without a detail
 * route yet).
 *
 * There is deliberately no project-required gating here (no
 * `findFirstTeamOwningAProject`, no project selector): creation at this org
 * surface is always available, matching the fact that these documents carry no
 * project.
 *
 * ISS-8938: this component is the ONE place the create flow consults
 * `documents-create-failure-recovery`, and the read picks between two whole
 * dialogs rather than being handed to either — the same shape the index uses to
 * choose its body. The BUTTON is outside the gate on purpose: it is shipped,
 * live behavior, and a closed-by-default gate over it would withdraw a
 * capability every organization has today rather than roll a new one out. What
 * the gate selects is how a REJECTED create reads.
 */
function useDocumentsCreateFlow() {
  const failureRecoveryEnabled = useFeatureFlagEnabled(
    DOCUMENTS_CREATE_FAILURE_RECOVERY_FEATURE_FLAG_KEY
  );
  const [open, setOpen] = useState(false);
  const [initialStatus, setInitialStatus] = useState<DocumentStatus>(
    DocumentStatus.Draft
  );
  // The arm chosen when the dialog opened, held for as long as it stays open.
  // PostHog resolves asynchronously and answers `false` until it does, so an
  // unlatched read can flip mid-dialog: React would then unmount one modal and
  // mount the other, taking the typed title, the rendered rejection, and the
  // in-flight `isSaving` guard with it — a user who had just been refused would
  // lose the title they were about to retry, and a create still in flight would
  // lose the guard that stops a second submit. `null` means "no dialog has been
  // opened yet", where following the live flag is free.
  const [armWhenOpened, setArmWhenOpened] = useState<boolean | null>(null);
  const useRecoverableArm = armWhenOpened ?? failureRecoveryEnabled;

  const handleOpenChange = (nextOpen: boolean) => {
    setArmWhenOpened(nextOpen ? failureRecoveryEnabled : null);
    setOpen(nextOpen);
  };

  return {
    onRequestCreate: (status?: GenericArtifact["status"]) => {
      setInitialStatus(
        Object.values(DocumentStatus).find(
          (raw) =>
            genericArtifactStatusFromRaw(GenericArtifactKind.Document, raw) ===
            status
        ) ?? DocumentStatus.Draft
      );
      handleOpenChange(true);
    },
    dialog: (
      <>
        {useRecoverableArm ? (
          <NewDocumentModalRecoverable
            initialStatus={initialStatus}
            onOpenChange={handleOpenChange}
            open={open}
          />
        ) : (
          <NewDocumentModal
            initialStatus={initialStatus}
            onOpenChange={handleOpenChange}
            open={open}
          />
        )}
      </>
    ),
  };
}

const DocumentsCreateContext = createContext<
  ((status?: GenericArtifact["status"]) => void) | null
>(null);

export function DocumentsCreateProvider({ children }: { children: ReactNode }) {
  const { onRequestCreate, dialog } = useDocumentsCreateFlow();
  return (
    <DocumentsCreateContext.Provider value={onRequestCreate}>
      {children}
      {dialog}
    </DocumentsCreateContext.Provider>
  );
}

export function useDocumentsCreateAction() {
  return useContext(DocumentsCreateContext);
}

export function DocumentsCreateAction({
  label = "New Document",
}: {
  label?: string;
} = {}) {
  const onRequestCreate = useDocumentsCreateAction();
  if (onRequestCreate) {
    return (
      <DocumentsCreateButton label={label} onRequestCreate={onRequestCreate} />
    );
  }
  return <StandaloneDocumentsCreateAction label={label} />;
}

function StandaloneDocumentsCreateAction({ label }: { label: string }) {
  const { onRequestCreate, dialog } = useDocumentsCreateFlow();
  return (
    <>
      <DocumentsCreateButton label={label} onRequestCreate={onRequestCreate} />
      {dialog}
    </>
  );
}

function DocumentsCreateButton({
  onRequestCreate,
  label,
}: {
  label: string;
  onRequestCreate: () => void;
}) {
  return (
    <HeaderPrimaryAction label={label} onClick={() => onRequestCreate()} />
  );
}
