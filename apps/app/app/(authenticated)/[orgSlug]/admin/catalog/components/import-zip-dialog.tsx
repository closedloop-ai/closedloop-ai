"use client";

import type { ImportPackZipResponse } from "@repo/api/src/types/distribution";
import { useImportPackZip } from "@repo/app/agents/hooks/use-catalog";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useState } from "react";
import { CatalogItemUpload } from "./catalog-item-upload";
import { ImportResultSummary } from "./import-result-summary";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packId: string;
  onImported: () => void;
};

/**
 * Import a Pack's components from an uploaded zip in the canonical Claude Code
 * layout. Uploads the zip to the Pack asset, then parses it server-side —
 * recognized files under agents, skills, commands, hooks, and .mcp.json become
 * child components.
 */
export function ImportZipDialog({
  open,
  onOpenChange,
  packId,
  onImported,
}: Props) {
  const importZip = useImportPackZip();
  const [uploaded, setUploaded] = useState(false);
  const [result, setResult] = useState<ImportPackZipResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUploaded(false);
    setResult(null);
    setError(null);
  };

  // Route every close (backdrop, Esc, or the Done button) through here so the
  // dialog's success state is cleared before it can be reopened. Radix never
  // calls the Dialog's own onOpenChange for an externally-controlled close, so
  // wiring Done straight to the parent open-setter would skip this reset.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  };

  const handleImport = async () => {
    setError(null);
    try {
      const res = await importZip.mutateAsync(packId);
      setResult(res);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import zip.");
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import from zip</DialogTitle>
          <DialogDescription>
            Upload a Pack zip in the Claude Code layout — recognized{" "}
            <span className="font-mono text-xs">agents/</span>,{" "}
            <span className="font-mono text-xs">skills/</span>,{" "}
            <span className="font-mono text-xs">commands/</span>, hooks, and{" "}
            <span className="font-mono text-xs">.mcp.json</span> files become
            components.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <CatalogItemUpload
            catalogItemId={packId}
            fileType="zip"
            onSuccess={() => setUploaded(true)}
          />
          {result ? <ImportResultSummary result={result} /> : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          ) : (
            <Button
              disabled={!uploaded || importZip.isPending}
              onClick={handleImport}
            >
              {importZip.isPending ? "Importing…" : "Import components"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
