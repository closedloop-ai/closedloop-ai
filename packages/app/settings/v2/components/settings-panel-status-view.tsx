"use client";

import {
  SETTINGS_PANEL_HOST_LABEL,
  SETTINGS_PANEL_LABEL,
  type SettingsPanelHost,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import {
  Button,
  buttonVariants,
} from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link } from "@repo/navigation/link";
import {
  LinkIcon,
  LockIcon,
  MonitorOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { SettingsPanelResolution } from "../lib/settings-panel-resolution";
import { SettingsPanelLoading } from "./settings-panel-boundary";

type SettingsPanelRecovery = {
  href: string;
  label: string;
};

type SettingsPanelStatusViewProps = {
  resolution: SettingsPanelResolution;
  host: SettingsPanelHost;
  recovery: SettingsPanelRecovery | null;
  onRetryCapabilities?: () => void;
};

// Names the panel the outcome is actually about. A plain visit whose default
// panel is denied has no `requestedPanel` to quote, and saying "that panel"
// there tells the user nothing about what was denied.
// A deep link can carry an arbitrarily long value, and the empty state's header
// is width-capped; echoing it whole would push the sentence off the card.
const MAX_ECHOED_PANEL_CHARS = 40;

function echoRequestedPanel(requestedPanel: string): string {
  return requestedPanel.length <= MAX_ECHOED_PANEL_CHARS
    ? requestedPanel
    : `${requestedPanel.slice(0, MAX_ECHOED_PANEL_CHARS)}…`;
}

function resolvedPanelName(resolution: SettingsPanelResolution): string {
  if (resolution.evaluatedPanelId !== null) {
    return SETTINGS_PANEL_LABEL[resolution.evaluatedPanelId];
  }
  return resolution.requestedPanel ?? "That panel";
}

function RecoveryAction({
  recovery,
}: Readonly<{ recovery: SettingsPanelRecovery | null }>): ReactNode {
  if (recovery === null) {
    return null;
  }
  return (
    <Link
      className={buttonVariants({ variant: "outline" })}
      href={recovery.href}
    >
      Open {recovery.label}
    </Link>
  );
}

/**
 * The non-ready outcomes, each rendered as its OWN screen (ISS-8362 AC1). One
 * shared "not found" for an unrecognised link and a denied one is the defect
 * this component exists to prevent: they have different causes, different
 * remedies, and a user told the wrong one acts on the wrong thing.
 *
 * Every screen carries the recovery link when one exists, so a bad deep link
 * leaves a way forward rather than a dead end. Returns null for `ready` — the
 * shell mounts the panel body instead.
 */
export function SettingsPanelStatusView(
  props: Readonly<SettingsPanelStatusViewProps>
) {
  return SETTINGS_PANEL_STATUS_SCREEN[props.resolution.status](props);
}

/**
 * One screen per status, keyed EXHAUSTIVELY by the union. A `Record` rather than
 * an if-chain with a trailing fallback: the fallback rendered every unmatched
 * status as `capability-error`, so a seventh status would have shipped wearing
 * the wrong cause and the wrong remedy without failing anything. Adding a status
 * now fails `tsc` here until it has been given its own screen.
 */
const SETTINGS_PANEL_STATUS_SCREEN: Record<
  SettingsPanelResolutionStatus,
  (props: Readonly<SettingsPanelStatusViewProps>) => ReactNode
> = {
  // The shell mounts the panel body instead.
  [SettingsPanelResolutionStatus.Ready]: () => null,

  [SettingsPanelResolutionStatus.Pending]: () => <SettingsPanelLoading />,

  [SettingsPanelResolutionStatus.Unknown]: ({ resolution, recovery }) => (
    <div data-settings-panel-state="unknown">
      <EmptyState
        action={<RecoveryAction recovery={recovery} />}
        description={`“${echoRequestedPanel(resolution.requestedPanel ?? "")}” is not a settings panel. The link may be out of date.`}
        icon={LinkIcon}
        title="That settings link doesn't point anywhere"
        titleAs="h2"
      />
    </div>
  ),

  [SettingsPanelResolutionStatus.Unavailable]: ({
    resolution,
    host,
    recovery,
  }) => (
    <div data-settings-panel-state="unavailable">
      <EmptyState
        action={<RecoveryAction recovery={recovery} />}
        description={`${resolvedPanelName(resolution)} isn't part of ${SETTINGS_PANEL_HOST_LABEL[host]}.`}
        icon={MonitorOffIcon}
        title={`${resolvedPanelName(resolution)} isn't available here`}
        titleAs="h2"
      />
    </div>
  ),

  [SettingsPanelResolutionStatus.Forbidden]: ({ resolution, recovery }) => (
    <div data-settings-panel-state="forbidden">
      <EmptyState
        action={<RecoveryAction recovery={recovery} />}
        description="Ask an organization admin if you need access to it."
        icon={LockIcon}
        title={`You don't have access to ${resolvedPanelName(resolution)}`}
        titleAs="h2"
      />
    </div>
  ),

  [SettingsPanelResolutionStatus.CapabilityError]: ({
    resolution,
    recovery,
    onRetryCapabilities,
  }) => (
    <div data-settings-panel-state="capability-error" role="alert">
      <EmptyState
        action={
          onRetryCapabilities ? (
            <Button
              onClick={onRetryCapabilities}
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          ) : (
            <RecoveryAction recovery={recovery} />
          )
        }
        description="This isn't a refusal. The permission check itself failed, so we can't say either way."
        icon={TriangleAlertIcon}
        title={`We couldn't check your access to ${resolvedPanelName(resolution)}`}
        titleAs="h2"
      />
    </div>
  ),
};
