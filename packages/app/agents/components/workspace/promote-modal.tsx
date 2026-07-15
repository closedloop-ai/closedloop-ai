"use client";

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import type { PromoteResponse } from "@repo/api/src/types/distribution";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useCallback, useEffect, useState } from "react";
import { usePromoteAgentComponent } from "../../hooks/use-promote";

type Props = {
  /** The discovered AgentComponent to promote to the catalog. */
  component: AgentComponent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the promote result on success. */
  onSuccess?: (result: PromoteResponse) => void;
};

/**
 * Best-of-breed promote modal (T-17.4 / AC-023).
 *
 * Accepts a discovered AgentComponent from the ranked inventory and pre-fills
 * name/description/targetKind. On submit: POST /agent-components/promote (admin-only).
 *
 * After success, shows the created catalogItemId + distributionId and prompts the
 * admin to upload a zip asset if one is needed.
 */
export function PromoteModal({
  component,
  open,
  onOpenChange,
  onSuccess,
}: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromoteResponse | null>(null);

  const promote = usePromoteAgentComponent();

  // Pre-fill from the component whenever the modal opens for it. Keying on
  // `open` (not just `component`) matters because `handleClose` resets the
  // fields on dismissal: the real header keeps the same component object
  // mounted while toggling `open`, so reopening it must re-run the prefill or
  // the Name field would stay blank.
  useEffect(() => {
    if (open && component) {
      setName(component.name);
      setDescription("");
      setError(null);
      setResult(null);
    }
  }, [open, component]);

  const handleSubmit = useCallback(async () => {
    if (!component) {
      return;
    }
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    try {
      const promoted = await promote.mutateAsync({
        agentComponentId: component.id,
        name: name.trim(),
        description: description.trim() || undefined,
        targetKind: component.kind,
      });
      setResult(promoted);
      onSuccess?.(promoted);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to promote component."
      );
    }
  }, [component, name, description, promote, onSuccess]);

  const handleClose = useCallback(() => {
    setName("");
    setDescription("");
    setError(null);
    setResult(null);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog
      onOpenChange={(next) => (next ? onOpenChange(true) : handleClose())}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote to Catalog</DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-green-600 text-sm">
              Component promoted successfully and distributed to all targets.
            </p>
            <div className="rounded-md bg-muted p-3 font-mono text-xs">
              <p>
                <span className="text-muted-foreground">Catalog item: </span>
                {result.catalogItemId}
              </p>
              <p>
                <span className="text-muted-foreground">Distribution: </span>
                {result.distributionId}
              </p>
            </div>
            <p className="text-muted-foreground text-sm">
              You can upload a zip asset to the catalog item to enable full
              auto-install support.
            </p>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            {component && (
              <p className="text-muted-foreground text-sm">
                Promoting{" "}
                <span className="font-medium text-foreground">
                  {component.name}
                </span>{" "}
                ({component.kind}) to the org catalog and distributing it to all
                targets.
              </p>
            )}

            <div className="flex flex-col gap-1">
              <Label className="font-medium text-sm" htmlFor="promote-name">
                Name
              </Label>
              <Input
                id="promote-name"
                onChange={(e) => setName(e.target.value)}
                placeholder="Component name"
                value={name}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label
                className="font-medium text-sm"
                htmlFor="promote-description"
              >
                Description{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="promote-description"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this component do?"
                rows={3}
                value={description}
              />
            </div>

            {error && <p className="text-destructive text-sm">{error}</p>}

            <DialogFooter>
              <Button
                disabled={promote.isPending}
                onClick={handleClose}
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={promote.isPending} onClick={handleSubmit}>
                {promote.isPending ? "Promoting…" : "Promote & Distribute"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
