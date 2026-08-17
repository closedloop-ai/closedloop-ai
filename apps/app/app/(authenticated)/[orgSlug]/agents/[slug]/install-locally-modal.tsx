"use client";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { LaptopIcon } from "lucide-react";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { SettingsTab } from "../../settings/settings-tabs";

type Props = {
  component: AgentComponentDetail;
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * FEA-4017 web "Install" modal. Available to ANY org member (no admin gate —
 * see the wrapper).
 *
 * The vetted install runs entirely on the member's own Desktop machine via the
 * local `desktop:db:catalog-install` path (localhost-only proxy guard + local
 * pack-catalog resolution), so the browser never spawns a CLI and never reaches
 * a non-localhost gateway. Remote gateway/relay dispatch of the install command
 * from the browser to a selected target's Desktop is deferred — it needs a new,
 * security-reviewed gateway catalog-install operation that does not exist yet.
 *
 * Until that lands, this modal is honest about that reality: it does NOT present
 * an actionable target picker (which would imply the web app installs onto a
 * chosen machine, which it cannot). Instead it tells the member where to
 * complete the install:
 *  - With at least one own registered target → list those machines read-only
 *    and direct the member to open the Desktop app on the machine they want and
 *    install from the component's detail there.
 *  - With no registered target → point them to Settings to register one (install
 *    and sign in to the Desktop app).
 *
 * Only the member's OWN targets are shown (`!ownerName`); a teammate-owned
 * org-shared target is not a machine this member can install on.
 */
export function InstallLocallyModal({
  component,
  orgSlug,
  open,
  onOpenChange,
}: Props) {
  // Optional read: the modal stays mounted while closed, so gate the query on
  // `open` (apps/app rule — defer optional reads until the action needs them).
  const {
    data: targets,
    isLoading,
    isError,
  } = useComputeTargets({ enabled: open });

  const ownTargets = (targets ?? []).filter((t) => !t.ownerName);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install {component.name}</DialogTitle>
          <DialogDescription>
            Installs run on your machine's Desktop app, which resolves the
            vetted local pack.
          </DialogDescription>
        </DialogHeader>

        {renderBody({ isError, isLoading, orgSlug, targets: ownTargets })}

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renderBody({
  isError,
  isLoading,
  orgSlug,
  targets,
}: {
  isError: boolean;
  isLoading: boolean;
  orgSlug: string;
  targets: readonly ComputeTarget[];
}) {
  if (isLoading) {
    // Skeleton shaped like a target row so the dialog does not resize under the
    // cursor once the targets land (plugins-panel uses the same pattern).
    return (
      <div className="flex flex-col gap-2 py-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <p className="py-2 text-destructive text-sm" role="alert">
        We couldn't load your compute targets. Check your connection and reopen
        this dialog.
      </p>
    );
  }

  if (targets.length === 0) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <p className="text-muted-foreground text-sm">
          You don't have a local compute target registered yet. Install and sign
          in to the Desktop app on the machine you want to install onto, then
          install from there.
        </p>
        <Button asChild className="self-start" type="button" variant="outline">
          <Link href={`/${orgSlug}/settings?tab=${SettingsTab.Integrations}`}>
            Go to Settings
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-muted-foreground text-sm">
        Open the Desktop app on the machine you want to install onto, then
        install this component from its detail there.
      </p>
      <div className="flex flex-col gap-1">
        {targets.map((target) => (
          <TargetRow key={target.id} target={target} />
        ))}
      </div>
    </div>
  );
}

/**
 * Read-only row for one of the member's own compute targets. Mirrors
 * `TargetOption` in compute-target-popover: a laptop icon tinted
 * `text-success` when online / `text-muted-foreground` when offline, with the
 * machine name over a "platform · Online|Offline" subtitle — so a target reads
 * the same wherever it appears. Not a control: the web app cannot dispatch the
 * install to it (deferred), so it carries no click affordance.
 */
function TargetRow({ target }: { target: ComputeTarget }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2 text-sm">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
        <LaptopIcon
          className={cn(
            "size-4",
            target.isOnline ? "text-success" : "text-muted-foreground"
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium leading-tight">
          {target.machineName}
        </p>
        <p className="truncate text-muted-foreground text-xs leading-tight">
          {target.platform} · {target.isOnline ? "Online" : "Offline"}
        </p>
      </div>
    </div>
  );
}
