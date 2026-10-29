"use client";

import type { Document, DocumentStatus } from "@repo/api/src/types/document";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { type FormEvent, useState } from "react";
import { useNewDocumentCreate } from "../hooks/use-new-document-create";
import { NewDocumentDialogShell } from "./new-document-dialog-shell";

/**
 * The document-type-agnostic New Document create flow for the org-level
 * Documents page (FEA-4345) — the SHIPPED arm, which the
 * `documents-create-failure-recovery` gate leaves in place when it is off
 * (ISS-8938). A Document is a first-class, org-level artifact: it does NOT
 * require a project. This modal collects a title, creates the artifact
 * project-less as a generic Document, and routes into its editor at
 * `/documents/[slug]` (ISS-4382).
 *
 * It intentionally does not reuse the project-scoped CreateDocumentModal: that
 * modal hardcodes a single subtype, requires a team + project selector, and
 * carries the PRD generation / repository-selection machinery, none of which
 * applies to an org-level document. Keeping this flow separate is what removes
 * the project-required gate from this entry point.
 *
 * On a REJECTED create this arm renders the raw message and the shared
 * QueryClient also toasts its own generic one, so one rejection is announced
 * twice. That is the behavior {@link NewDocumentModalRecoverable} replaces, and
 * it is preserved verbatim here because a closed gate must leave the shipped
 * surface exactly as it was.
 *
 * This lives in `@repo/app` (not `apps/app`) because it encodes document-domain
 * concepts — document type, status defaults, creation, and document navigation
 * — so both the web shell and the desktop renderer consume one implementation
 * (AGENTS.md UI Component Placement).
 */

export type NewDocumentModalProps = {
  open: boolean;
  initialStatus?: DocumentStatus;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (artifact: Document) => void;
};

export function NewDocumentModal({
  open,
  onOpenChange,
  onSuccess,
  initialStatus,
}: Readonly<NewDocumentModalProps>) {
  const { create, isSaving } = useNewDocumentCreate(undefined, initialStatus);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    onOpenChange(false);
    setTitle("");
    setError(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Please enter a title");
      return;
    }

    create(trimmed, {
      onCreated: (artifact) => {
        handleClose();
        onSuccess?.(artifact);
      },
      // Surface the failure inside the dialog, where the user is looking,
      // instead of only behind the global toast. The dialog stays open with
      // the title intact so they can retry. Only the sentence is taken, never
      // the heading or remediation the recoverable arm renders: with the gate
      // closed this surface must read exactly as it shipped.
      onFailure: (failure) => setError(failure.description),
    });
  };

  return (
    <NewDocumentDialogShell
      failure={
        error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null
      }
      isSaving={isSaving}
      onDismiss={handleClose}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      onTitleChange={setTitle}
      open={open}
      submitLabel="Create Document"
      title={title}
    />
  );
}
