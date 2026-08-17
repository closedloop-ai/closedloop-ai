"use client";

import { NewDocumentModal } from "@repo/app/documents/components/new-document-modal";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

/**
 * First-class create entry point for the org-level Documents page (FEA-4345).
 * A Document is a first-class, type-agnostic, org-level artifact — it does NOT
 * require a project — so this action is a primary "New Document" button that
 * opens the type-agnostic {@link NewDocumentModal}. The modal collects a title,
 * creates the artifact project-less as a generic Document, and routes into its
 * detail page (or leaves the user on this index for a type without a detail
 * route yet).
 *
 * There is deliberately no project-required gating here (no
 * `findFirstTeamOwningAProject`, no project selector): creation at this org
 * surface is always available, matching the fact that these documents carry no
 * project.
 */
export function DocumentsCreateAction() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} type="button">
        <PlusIcon className="h-4 w-4" />
        New Document
      </Button>
      <NewDocumentModal onOpenChange={setOpen} open={open} />
    </>
  );
}
