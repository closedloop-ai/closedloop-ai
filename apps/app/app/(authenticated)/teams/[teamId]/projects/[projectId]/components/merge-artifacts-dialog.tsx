"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { ArrowLeftRightIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { formatRelativeTime } from "@/lib/date-utils";
import { ArtifactTypeBadge } from "./artifact-type-badge";

type MergeArtifactsDialogProps = {
  artifacts: [ArtifactWithWorkstream, ArtifactWithWorkstream];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (primaryId: string, secondaryId: string) => Promise<void>;
  isPending: boolean;
  error?: string | null;
};

export function MergeArtifactsDialog({
  artifacts,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  error,
}: MergeArtifactsDialogProps) {
  const [primaryId, setPrimaryId] = useState<string>(artifacts[0].id);

  const primaryArtifact =
    artifacts[0].id === primaryId ? artifacts[0] : artifacts[1];
  const secondaryArtifact =
    artifacts[0].id === primaryId ? artifacts[1] : artifacts[0];

  const handleSwap = () => {
    setPrimaryId(secondaryArtifact.id);
  };

  const handleConfirm = async () => {
    await onConfirm(primaryArtifact.id, secondaryArtifact.id);
  };

  return (
    <Dialog
      onOpenChange={(o) => {
        if (!isPending) {
          onOpenChange(o);
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Merge Artifacts</DialogTitle>
          <DialogDescription>
            The primary artifact will survive. The secondary artifact will be
            deleted after merging.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div className="space-y-1">
              <p className="font-medium text-sm">Primary (survives)</p>
              <Card key={`primary-${primaryArtifact.id}`}>
                <CardHeader className="pt-4 pb-2">
                  <CardTitle className="font-medium text-sm leading-tight">
                    {primaryArtifact.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                  <div className="space-y-2">
                    <ArtifactTypeBadge type={primaryArtifact.type} />
                    <p className="text-muted-foreground text-xs">
                      Updated {formatRelativeTime(primaryArtifact.updatedAt)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Button
              className="mb-4"
              disabled={isPending}
              onClick={handleSwap}
              size="icon"
              title="Swap primary and secondary"
              type="button"
              variant="outline"
            >
              <ArrowLeftRightIcon className="size-4" />
              <span className="sr-only">Swap</span>
            </Button>

            <div className="space-y-1">
              <p className="font-medium text-sm">Secondary (will be deleted)</p>
              <Card
                className="border-destructive/30"
                key={`secondary-${secondaryArtifact.id}`}
              >
                <CardHeader className="pt-4 pb-2">
                  <CardTitle className="font-medium text-sm leading-tight">
                    {secondaryArtifact.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                  <div className="space-y-2">
                    <ArtifactTypeBadge type={secondaryArtifact.type} />
                    <p className="text-muted-foreground text-xs">
                      Updated {formatRelativeTime(secondaryArtifact.updatedAt)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {error ? (
            <p className="mt-3 text-destructive text-sm">{error}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isPending} onClick={handleConfirm} type="button">
            {isPending ? (
              <>
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Merging...
              </>
            ) : (
              "Merge"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
