"use client";

import type { Harness } from "@repo/app/agents/lib/session-types";
import { Button } from "@repo/design-system/components/ui/button";
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Share2Icon,
} from "lucide-react";
import type { PackView } from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import { harnessLabel } from "./pack-meta";

export type InstallAction = "install" | "uninstall" | "update";

export type InstallPending = {
  harness: Harness;
  action: InstallAction;
};

type InstallControlsProps = {
  pack: PackView;
  context: PacksContext;
  /** The harness+action currently running (disables that button, shows a spinner). */
  pending?: InstallPending | null;
  /** Inline error from the last mutation. */
  error?: string | null;
  onInstall?: (packId: string, harness: Harness) => void;
  onUninstall?: (packId: string, harness: Harness) => void;
  onUpdate?: (packId: string, harness: Harness) => void;
  /** Admin: open the distribution editor for this pack. */
  onDistribute?: (packId: string) => void;
};

const pendingLabel: Record<InstallAction, string> = {
  install: "Installing…",
  uninstall: "Removing…",
  update: "Updating…",
};

// Per-harness install / update / uninstall controls (preserves the desktop
// plugins-panel behavior). One column per supported harness.
const HarnessControls = ({
  pack,
  pending,
  onInstall,
  onUninstall,
  onUpdate,
}: Pick<
  InstallControlsProps,
  "pack" | "pending" | "onInstall" | "onUninstall" | "onUpdate"
>) => (
  <div className="flex flex-wrap items-center gap-2">
    {pack.harnesses.map((harness) => {
      const installed = pack.installedHarnesses.includes(harness);
      const isPending = pending?.harness === harness;
      const label = harnessLabel(harness);
      if (installed) {
        return (
          <div className="flex items-center gap-1" key={harness}>
            <Button
              disabled={isPending}
              onClick={() => onUpdate?.(pack.id, harness)}
              size="sm"
              variant="outline"
            >
              {isPending && pending?.action === "update"
                ? pendingLabel.update
                : `Update ${label}`}
            </Button>
            <Button
              disabled={isPending}
              onClick={() => onUninstall?.(pack.id, harness)}
              size="sm"
              variant="ghost"
            >
              {isPending && pending?.action === "uninstall"
                ? pendingLabel.uninstall
                : "Uninstall"}
            </Button>
          </div>
        );
      }
      return (
        <Button
          className="gap-1.5"
          disabled={isPending}
          key={harness}
          onClick={() => onInstall?.(pack.id, harness)}
          size="sm"
        >
          <DownloadIcon className="size-3.5" />
          {isPending && pending?.action === "install"
            ? pendingLabel.install
            : `Install ${label}`}
        </Button>
      );
    })}
  </div>
);

/**
 * The pack detail-header action zone. Renders per-harness local install controls
 * on install-capable surfaces (desktop), and admin distribution / GitHub actions
 * on the web.
 */
// Local install zone (desktop): per-harness controls, or an "Installed" pill for
// harness-agnostic packs that expose no per-harness list.
const LocalInstallZone = ({
  pack,
  pending,
  onInstall,
  onUninstall,
  onUpdate,
}: Pick<
  InstallControlsProps,
  "pack" | "pending" | "onInstall" | "onUninstall" | "onUpdate"
>) => {
  if (pack.harnesses.length > 0) {
    return (
      <HarnessControls
        onInstall={onInstall}
        onUninstall={onUninstall}
        onUpdate={onUpdate}
        pack={pack}
        pending={pending}
      />
    );
  }
  if (pack.installedByMe) {
    return (
      <Button className="gap-1.5" disabled size="sm" variant="secondary">
        <CheckIcon className="size-4" />
        Installed
      </Button>
    );
  }
  return null;
};

export const InstallControls = ({
  pack,
  context,
  pending,
  error,
  onInstall,
  onUninstall,
  onUpdate,
  onDistribute,
}: InstallControlsProps) => {
  const { capabilities } = context;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {capabilities.installLocally ? (
          <LocalInstallZone
            onInstall={onInstall}
            onUninstall={onUninstall}
            onUpdate={onUpdate}
            pack={pack}
            pending={pending}
          />
        ) : null}

        {capabilities.manageDistribution && onDistribute ? (
          <Button
            className="gap-1.5"
            onClick={() => onDistribute(pack.id)}
            size="sm"
          >
            <Share2Icon className="size-4" />
            Distribute
          </Button>
        ) : null}

        {pack.githubUrl ? (
          <Button asChild className="gap-1.5" size="sm" variant="outline">
            <a href={pack.githubUrl} rel="noreferrer" target="_blank">
              <ExternalLinkIcon className="size-4" />
              GitHub
            </a>
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
};
