"use client";

import {
  type ComputeTarget,
  isComputeTargetOwnedByViewer,
} from "@repo/api/src/types/compute-target";
import { Badge } from "@repo/design-system/components/ui/badge";
import { LaptopIcon } from "lucide-react";
import { COMPUTE_TARGETS_QUERY_OPTIONS } from "../../../../compute/hooks/compute-target-query-options";
import { useComputeTargets } from "../../../../compute/hooks/use-compute-targets";
import { formatRelativeTime } from "../../../../shared/lib/date-utils";
import type { SettingsLocalDeviceState } from "../../../../shared/settings-host/use-settings-local-device";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import {
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";
import { DevicePanelInlineEmptyState } from "./device-panel-group";
import { isLocalComputeTarget } from "./local-device-correlation";

/**
 * The registered Desktop rows of Connected Devices (PLN-1915 Step 3, D5).
 *
 * READ-ONLY. ISS-12784 deleted the web surface that managed compute targets
 * (removal, updates, security), and none of those controls moved here.
 *
 * IT SAYS NOTHING ABOUT ANOTHER DEVICE'S SYNC POLICY. Production has no
 * per-device policy to report: `ComputeTarget` carries no such column, and the
 * only `dataSyncLevel` in the schema is stamped per SESSION by whichever
 * machine last synced one. Deriving a device's posture from its most recent
 * session would render a fabricated measurement, and would show nothing at all
 * for exactly the devices that keep everything local (ISS-8366's v1 ruling).
 */

const DESKTOP_SUBJECT = "your registered desktops";

export function RegisteredDesktopsSection({
  localDevice,
}: Readonly<{ localDevice: SettingsLocalDeviceState }>) {
  // The shared compute-target freshness contract: the online/offline badge
  // below is a liveness claim, and on the client's 60s default with no poll it
  // would only move when the window regained focus.
  const targets = useComputeTargets(COMPUTE_TARGETS_QUERY_OPTIONS);
  // Viewer-owned only: a target an older API lists for another member is
  // theirs, and this panel is about the devices the signed-in user has
  // connected. The predicate is the API type's own, not a local copy.
  const owned = targets.data?.filter(isComputeTargetOwnedByViewer);

  const dataState = classifySettingsPanelRead({
    error: targets.error,
    hasData: owned !== undefined,
    isEmpty: (owned?.length ?? 0) === 0,
    isPending: targets.isPending,
  });

  if (dataState === SettingsPanelDataState.Empty) {
    return (
      <DevicePanelInlineEmptyState
        description="Install the Closedloop Desktop client and connect it to see it here."
        icon={LaptopIcon}
        title="No registered desktops"
      />
    );
  }

  if (dataState !== SettingsPanelDataState.Ready || !owned) {
    return (
      <SettingsPanelDataStateView
        onRetry={() => {
          targets.refetch();
        }}
        state={dataState}
        subject={DESKTOP_SUBJECT}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {owned.map((target) => (
        <RegisteredDesktopRow
          isThisDevice={isLocalComputeTarget(target, localDevice)}
          key={target.id}
          target={target}
        />
      ))}
    </ul>
  );
}

function RegisteredDesktopRow({
  target,
  isThisDevice,
}: Readonly<{ target: ComputeTarget; isThisDevice: boolean }>) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
      data-registered-desktop-current={isThisDevice ? "true" : "false"}
      data-registered-desktop-row={target.id}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-sm">{target.machineName}</p>
          <Badge variant={target.isOnline ? "default" : "secondary"}>
            {target.isOnline ? "online" : "offline"}
          </Badge>
          {isThisDevice ? <Badge variant="secondary">This device</Badge> : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {target.platform} · Last seen {formatRelativeTime(target.lastSeenAt)}
        </p>
      </div>
    </li>
  );
}
