"use client";

import type { ImportPackZipResponse } from "@repo/api/src/types/distribution";
import { useImportPackRepo } from "@repo/app/agents/hooks/use-catalog";
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
import { useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packId: string;
  onImported: () => void;
};

/**
 * Import a Pack's components from a GitHub repo the org has App visibility to.
 * Point at owner/name (optionally a subpath like .claude) and recognized files
 * under agents, skills, commands, hooks, and .mcp.json become components — for
 * orgs distributing a central shared-asset repo.
 */
export function ImportRepoDialog({
  open,
  onOpenChange,
  packId,
  onImported,
}: Props) {
  const importRepo = useImportPackRepo();
  const [repoFullName, setRepoFullName] = useState("");
  const [subPath, setSubPath] = useState("");
  const [result, setResult] = useState<ImportPackZipResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setRepoFullName("");
    setSubPath("");
    setResult(null);
    setError(null);
  };

  // Route every close (backdrop, Esc, or the Done button) through here so the
  // dialog's success/input state is cleared before it can be reopened.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  };

  const handleImport = async () => {
    setError(null);
    if (!repoFullName.trim().includes("/")) {
      setError("Enter a repository as owner/name.");
      return;
    }
    try {
      const res = await importRepo.mutateAsync({
        packId,
        repoFullName: repoFullName.trim(),
        subPath: subPath.trim() || undefined,
      });
      setResult(res);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import.");
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import from repo</DialogTitle>
          <DialogDescription>
            Point at a repo your org has GitHub access to. Recognized files
            under agents, skills, commands, hooks, and .mcp.json become
            components.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-sm" htmlFor="repo-full-name">
              Repository <span className="text-destructive">*</span>
            </Label>
            <Input
              id="repo-full-name"
              onChange={(e) => setRepoFullName(e.target.value)}
              placeholder="owner/name"
              value={repoFullName}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-sm" htmlFor="repo-subpath">
              Subpath <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="repo-subpath"
              onChange={(e) => setSubPath(e.target.value)}
              placeholder=".claude"
              value={subPath}
            />
          </div>

          {result ? (
            <p className="text-sm">
              Imported {result.created} component
              {result.created === 1 ? "" : "s"}
              {result.skipped > 0
                ? `, skipped ${result.skipped} already present`
                : ""}
              .
            </p>
          ) : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          ) : (
            <Button disabled={importRepo.isPending} onClick={handleImport}>
              {importRepo.isPending ? "Importing…" : "Import components"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
