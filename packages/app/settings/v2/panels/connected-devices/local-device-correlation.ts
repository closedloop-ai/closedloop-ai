import { SettingsLocalDeviceStatus } from "@repo/api/src/types/settings-host-capabilities";
import type { SettingsLocalDeviceState } from "../../../../shared/settings-host/use-settings-local-device";

/**
 * Which registered Desktop row, if any, is the machine the user is looking at
 * (PLN-1915 Step 3).
 *
 * `computeTargetId` is the correlation key when the host has one; it is OMITTED
 * rather than nulled when this desktop is not currently online in the cloud, so
 * `machineName` is the offline fallback — a cloud compute-target row is unique
 * per owner and machine name, and the list this runs against is already
 * filtered to rows the viewer owns.
 *
 * A projection that is not `Ready` correlates with NOTHING. A pending or
 * unavailable host read is not evidence that a row is or is not this machine,
 * and marking one anyway would put "This device" on a guess.
 */
export function isLocalComputeTarget(
  target: Readonly<{ id: string; machineName: string }>,
  localDevice: SettingsLocalDeviceState
): boolean {
  if (
    localDevice.status !== "settled" ||
    localDevice.projection.status !== SettingsLocalDeviceStatus.Ready
  ) {
    return false;
  }
  const { computeTargetId, machineName } = localDevice.projection.snapshot;
  if (computeTargetId !== undefined) {
    return computeTargetId === target.id;
  }
  return machineName === target.machineName;
}
