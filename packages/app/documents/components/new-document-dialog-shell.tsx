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
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { LoaderIcon } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

/**
 * The one-field New Document dialog's presentation, shared by both arms of the
 * `documents-create-failure-recovery` gate (ISS-8938).
 *
 * Extracted rather than copied: the arms differ only in how a REJECTION reads,
 * so everything else — the single Title field, the in-flight dismissal guards,
 * the footer — has one definition and cannot drift between them. What each arm
 * supplies is a `failure` node and the submit label.
 */

export type NewDocumentDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dismissal the shell has already established is allowed (not mid-create). */
  onDismiss: () => void;
  title: string;
  onTitleChange: (title: string) => void;
  onSubmit: (event: FormEvent) => void;
  isSaving: boolean;
  /** Footer submit copy while idle; the in-flight copy is the shell's own. */
  submitLabel: string;
  /** The arm's account of a rejected create, rendered above the field. */
  failure?: ReactNode;
  /**
   * The `id` of that account, when the arm has one to point at, so a reader who
   * cannot see the alert still reaches it from the field via
   * `aria-describedby`. It deliberately does NOT mark the field invalid: most
   * reachable rejections here are about the request, not the title (an
   * authorization refusal, a 5xx, a client deadline), and `aria-invalid` on a
   * perfectly valid title would tell a screen-reader user to go fix a field
   * that is not the problem. An arm that omits this renders the field's
   * attributes exactly as before, which keeps the closed-gate arm's DOM
   * unchanged.
   */
  failureId?: string;
};

export function NewDocumentDialogShell({
  open,
  onOpenChange,
  onDismiss,
  title,
  onTitleChange,
  onSubmit,
  isSaving,
  submitLabel,
  failure,
  failureId,
}: Readonly<NewDocumentDialogShellProps>) {
  const canSubmit = title.trim() !== "";

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        if (newOpen) {
          onOpenChange(true);
        } else if (!isSaving) {
          // Ignore dismissal while the create request is in flight: a stray
          // Escape / outside-click during the await must not close the dialog
          // and let a late success navigate or clobber a reopened dialog.
          onDismiss();
        }
      }}
      open={open}
    >
      <DialogContent
        className="sm:max-w-[500px]"
        onEscapeKeyDown={(event) => {
          if (isSaving) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isSaving) {
            event.preventDefault();
          }
        }}
      >
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Create Document</DialogTitle>
            <DialogDescription className="sr-only">
              Create a new org-level document. No project is required.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {failure}

            <div className="space-y-2">
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="new-document-title"
              >
                Title<span className="text-destructive">*</span>
              </Label>
              <Input
                aria-describedby={failureId}
                autoFocus
                id="new-document-title"
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="Enter document title"
                value={title}
              />
            </div>
          </div>

          <DialogFooter>
            {/* Disabled mid-create for the same reason Escape and
                outside-click are ignored above: the POST is already on the
                wire and cannot be recalled, so a dismissal here would leave a
                late success to navigate the user into a document they had just
                cancelled — the UI reporting one outcome while another lands. */}
            <Button
              disabled={isSaving}
              onClick={onDismiss}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={!canSubmit || isSaving} type="submit">
              {isSaving ? (
                <>
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                submitLabel
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
