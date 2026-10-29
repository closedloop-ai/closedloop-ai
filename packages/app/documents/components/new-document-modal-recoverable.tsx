"use client";

import type { Document, DocumentStatus } from "@repo/api/src/types/document";
import type { MutationToastOptions } from "@repo/app/shared/query/query-client";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { NewDocumentCreateFailure } from "../hooks/use-new-document-create";
import { useNewDocumentCreate } from "../hooks/use-new-document-create";
import { NewDocumentDialogShell } from "./new-document-dialog-shell";

/**
 * The one-field New Document flow with a first-class failure path (ISS-8938,
 * PRD-695 §3) — the arm the `documents-create-failure-recovery` gate selects
 * when it is ON.
 *
 * What it creates and where it lands are its sibling's, unchanged: both arms
 * call {@link useNewDocumentCreate}, so both create the same organization-level,
 * project-less `DOC` and land in the same editor. What differs is the rejection.
 *
 * A rejected create is said ONCE, here, where the reader is looking. The shared
 * QueryClient's generic "Operation failed" toast is suppressed for this mutation
 * alone — the opt-in `MutationToastOptions` its hook already takes, not a change
 * to any shared default — because this dialog now reports every reachable
 * failure itself, which is the condition `packages/app/AGENTS.md` attaches to
 * setting that flag. Without it one rejection arrived as two unrelated accounts
 * and neither named the other.
 *
 * The typed title survives, so a retry is a click rather than re-typing, and the
 * submit control says so.
 */

/** This dialog owns the whole message, so the shared toast would be a second one. */
const SUPPRESS_DEFAULT_ERROR_TOAST: MutationToastOptions = {
  suppressDefaultErrorToast: true,
};

/** Points the field at the account of the failure (`aria-describedby`). */
const FAILURE_ALERT_ID = "new-document-create-failure";

const RETRY_SUBMIT_LABEL = "Try again";
const FIRST_ATTEMPT_SUBMIT_LABEL = "Create Document";

export type NewDocumentModalRecoverableProps = {
  open: boolean;
  initialStatus?: DocumentStatus;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (artifact: Document) => void;
};

export function NewDocumentModalRecoverable({
  open,
  onOpenChange,
  onSuccess,
  initialStatus,
}: Readonly<NewDocumentModalRecoverableProps>) {
  const { create, isSaving } = useNewDocumentCreate(
    SUPPRESS_DEFAULT_ERROR_TOAST,
    initialStatus
  );
  const [title, setTitle] = useState("");
  const [failure, setFailure] = useState<NewDocumentCreateFailure | null>(null);

  const handleClose = () => {
    onOpenChange(false);
    setTitle("");
    setFailure(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Clear the previous account before the new attempt, so a stale rejection
    // is never read as the verdict on the attempt now in flight.
    setFailure(null);
    // Unreachable through the UI — the submit control is disabled on a blank
    // title, which also suppresses the form's implicit Enter submission — and
    // deliberately silent rather than reported: nothing was attempted, so this
    // block's "Couldn't create this document" would be a rejection that never
    // happened. The guard stays so no empty title can reach the wire.
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }

    create(trimmed, {
      onCreated: (artifact) => {
        handleClose();
        onSuccess?.(artifact);
      },
      onFailure: setFailure,
    });
  };

  return (
    <NewDocumentDialogShell
      failure={
        failure ? (
          <Alert id={FAILURE_ALERT_ID} variant="error">
            <AlertCircleIcon />
            {/* The heading is the hook's, not a constant here: a refusal and a
                client deadline are different events and must not share one. */}
            <AlertTitle>{failure.title}</AlertTitle>
            {/* The server's own sentence, and nothing added after it: the
                retry control says what to do next and the typed title is
                visible in the field below, so a third line would only narrate
                the dialog back at the reader. The exception is a failure that
                carries canonical remediation — a timeout, where "it may still
                be finishing" is only actionable with the step that follows. */}
            <AlertDescription>
              {failure.description}
              {failure.remediation && failure.remediation.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {failure.remediation.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null
      }
      failureId={failure ? FAILURE_ALERT_ID : undefined}
      isSaving={isSaving}
      onDismiss={handleClose}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      onTitleChange={setTitle}
      open={open}
      submitLabel={failure ? RETRY_SUBMIT_LABEL : FIRST_ATTEMPT_SUBMIT_LABEL}
      title={title}
    />
  );
}
