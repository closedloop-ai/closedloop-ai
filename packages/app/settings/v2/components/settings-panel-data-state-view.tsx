"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { capitalize } from "@repo/design-system/lib/utils";
import {
  LockIcon,
  type LucideIcon,
  TriangleAlertIcon,
  WifiOffIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { SettingsPanelDataState } from "../lib/settings-panel-data-state";

export type SettingsPanelEmptyCopy = {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
};

type SettingsPanelDataStateViewProps = {
  state: SettingsPanelDataState;
  /**
   * What the panel was trying to read, as a PLURAL noun phrase that reads
   * correctly both as an object ("We couldn't load your API keys") and as a
   * subject ("Your API keys aren't available right now"). Lower-case; the
   * screens below supply the frame and capitalise where they need to.
   */
  subject: string;
  /**
   * Omit when the panel has no reachable empty state — a single scalar setting
   * is never an empty collection — so no unreachable copy is written for one.
   */
  empty?: SettingsPanelEmptyCopy;
  onRetry?: () => void;
};

/**
 * The non-ready states of a Settings v2 panel body, each rendered as its own
 * screen (ISS-8369).
 *
 * Sibling of `SettingsPanelStatusView`, which does the same job for whether the
 * panel opens at all. Kept apart from that one because they answer to different
 * inputs — that one to the actor's capability projection, this one to the
 * panel's own read — and folding them would make a body's failed list look like
 * a denied panel.
 *
 * Returns `null` for `ready`; the panel renders its content instead.
 */
export function SettingsPanelDataStateView({
  state,
  subject,
  empty,
  onRetry,
}: Readonly<SettingsPanelDataStateViewProps>) {
  return SETTINGS_PANEL_DATA_STATE_SCREEN[state]({
    empty,
    onRetry,
    state,
    subject,
  });
}

function RetryAction({
  onRetry,
}: Readonly<{ onRetry?: () => void }>): ReactNode {
  if (onRetry === undefined) {
    return null;
  }
  return (
    <Button onClick={onRetry} type="button" variant="outline">
      Try again
    </Button>
  );
}

/**
 * One screen per state, keyed EXHAUSTIVELY by the union so a new state fails
 * `tsc` here rather than silently inheriting another state's cause and remedy.
 * The same `Record` shape, and the same reason for it, as
 * `SETTINGS_PANEL_STATUS_SCREEN` next door.
 */
const SETTINGS_PANEL_DATA_STATE_SCREEN: Record<
  SettingsPanelDataState,
  (props: Readonly<SettingsPanelDataStateViewProps>) => ReactNode
> = {
  // The panel renders its content instead.
  [SettingsPanelDataState.Ready]: () => null,

  [SettingsPanelDataState.Loading]: ({ subject }) => (
    <div
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-3"
      data-settings-panel-data-state="loading"
      role="status"
    >
      <span className="sr-only">Loading {subject}</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-2/3" />
    </div>
  ),

  [SettingsPanelDataState.Empty]: ({ empty }) =>
    empty === undefined ? null : (
      <div data-settings-panel-data-state="empty">
        <EmptyState
          action={empty.action}
          description={empty.description}
          icon={empty.icon}
          size="compact"
          title={empty.title}
        />
      </div>
    ),

  [SettingsPanelDataState.Forbidden]: ({ subject }) => (
    <div data-settings-panel-data-state="forbidden">
      <EmptyState
        description="Your organization role doesn't cover this."
        icon={LockIcon}
        size="compact"
        title={`You don't have access to ${subject}`}
      />
    </div>
  ),

  [SettingsPanelDataState.Unavailable]: ({ subject, onRetry }) => (
    <div data-settings-panel-data-state="unavailable" role="alert">
      <EmptyState
        action={<RetryAction onRetry={onRetry} />}
        description="This isn't a refusal. The service didn't answer, so nothing about your access was decided."
        icon={WifiOffIcon}
        size="compact"
        title={`${capitalize(subject)} aren't available right now`}
      />
    </div>
  ),

  [SettingsPanelDataState.Failed]: ({ subject, onRetry }) => (
    <div data-settings-panel-data-state="failed" role="alert">
      <EmptyState
        action={<RetryAction onRetry={onRetry} />}
        description="Nothing was changed. The request didn't complete."
        icon={TriangleAlertIcon}
        size="compact"
        title={`We couldn't load ${subject}`}
      />
    </div>
  ),
};
