"use client";

import {
  type Document,
  DocumentType,
  fallbackStatusForSubtype,
} from "@repo/api/src/types/document";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { LoaderIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useCreateDocument } from "../hooks/use-documents";
import { getDocumentRoute } from "../lib/document-navigation";

/**
 * The document-type-agnostic New Document create flow for the org-level
 * Documents page (FEA-4345). A Document is a first-class, org-level artifact:
 * it does NOT require a project. This modal collects a title, creates the
 * artifact project-less via the org-level create path as a generic
 * {@link DocumentType.Doc}, and routes into its editor at `/documents/[slug]`
 * (ISS-4382). The `getDocumentRoute` null-guard is kept so navigation is
 * skipped gracefully for any future subtype without a detail route.
 *
 * It intentionally does not reuse the project-scoped CreateDocumentModal: that
 * modal hardcodes a single subtype, requires a team + project selector, and
 * carries the PRD generation / repository-selection machinery, none of which
 * applies to an org-level document. Keeping this flow separate is what removes
 * the project-required gate from this entry point.
 *
 * This lives in `@repo/app` (not `apps/app`) because it encodes document-domain
 * concepts — document type, status defaults, creation, and document navigation
 * — so both the web shell and the desktop renderer consume one implementation
 * (AGENTS.md UI Component Placement).
 */

// The single document type this org-level flow creates. It is deliberately the
// generic Document (not PRD/Implementation Plan/Feature, which need a project +
// repository context and are created from their own project surfaces; and not
// Template, which has no owning list/detail surface yet, so a created Template
// would vanish from the Doc-only index with no way to reopen it). Because there
// is exactly one type, this modal exposes no type selector — a one-field dialog
// that does exactly what its name says.
const ORG_LEVEL_DOCUMENT_TYPE: DocumentType = DocumentType.Doc;

export type NewDocumentModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (artifact: Document) => void;
};

export function NewDocumentModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<NewDocumentModalProps>) {
  const buildOrgPath = useOrgPath();
  const navigation = useNavigation();
  const createDocument = useCreateDocument();

  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setTitle("");
    setError(null);
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    // No projectId: an org-level Document carries no project. The create
    // validator only requires one for project-bound subtypes.
    createDocument.mutate(
      {
        type: ORG_LEVEL_DOCUMENT_TYPE,
        title: title.trim(),
        content: "",
        status: fallbackStatusForSubtype(ORG_LEVEL_DOCUMENT_TYPE),
      },
      {
        onSuccess: (artifact) => {
          handleClose();
          onSuccess?.(artifact);
          const route = getDocumentRoute(artifact);
          if (route) {
            navigation.navigate(buildOrgPath(route));
          }
        },
        // Surface the failure inside the dialog, where the user is looking,
        // instead of only behind the global toast. The dialog stays open with
        // the title intact so they can retry.
        onError: (mutationError: Error) => {
          setError(
            mutationError.message ||
              "Couldn't create the document. Please try again."
          );
        },
      }
    );
  };

  const canSubmit = !!title.trim();
  const isSaving = createDocument.isPending;

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        if (newOpen) {
          onOpenChange(true);
        } else if (!isSaving) {
          // Ignore dismissal while the create request is in flight: a stray
          // Escape / outside-click during the await must not close the dialog
          // and let a late success navigate or clobber a reopened dialog.
          handleClose();
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
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Document</DialogTitle>
            <DialogDescription className="sr-only">
              Create a new org-level document. No project is required.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2">
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="new-document-title"
              >
                Title<span className="text-destructive">*</span>
              </Label>
              <Input
                autoFocus
                id="new-document-title"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Enter document title"
                value={title}
              />
            </div>
          </div>

          <DialogFooter>
            <Button onClick={handleClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!canSubmit || isSaving} type="submit">
              {isSaving ? (
                <>
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Document"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
