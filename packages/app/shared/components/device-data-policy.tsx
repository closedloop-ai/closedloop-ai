"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { cn } from "@repo/design-system/lib/utils";
import { DataSyncPolicySummary } from "./data-sync-policy-summary";
import {
  type AutoExcludedDirectory,
  type DirectoryScopeEntry,
  DirectoryScopeList,
  type DirectoryScopeListCopy,
} from "./directory-scope-list";
import {
  POLICY_STATUS,
  PolicyStatusIndicator,
} from "./policy-status-indicator";

/**
 * @file ISS-12531 (PRD-806): one desktop device's data policy, shown READ-ONLY
 * on web.
 *
 * DESIGN-ONLY. No API reports another device's policy to web today:
 * `ComputeTarget` has no sync-policy column, and the only `dataSyncLevel` in
 * the schema is stamped per session by whichever machine last synced it
 * (`SettingsLocalSyncPolicyProjection` and `RegisteredDesktopsSection` both
 * record ISS-8366's ruling that deriving a device's posture from its latest
 * session would be a fabricated measurement). So everything comes in as
 * props, and no production host renders this yet. Its intended home is the
 * registered-desktop row of Connected Devices
 * (`packages/app/settings/v2/panels/connected-devices/registered-desktops-section.tsx`),
 * once a producer exists.
 *
 * It composes the shipped pieces rather than drawing its own:
 * `PolicyStatusIndicator` for reported vs not reported,
 * `DataSyncPolicySummary` for the level, directory count and machine, and
 * `DirectoryScopeList` (read-only) for which directories are in scope.
 *
 * READ-ONLY BY CONSTRUCTION (AC-003): there is no change handler to pass, and
 * the scope list is locked. Whether a policy can be edited remotely is an open
 * question on the ticket; until it is answered, web offers no edit at all.
 *
 * Every string is a required `copy` prop. None of the new wording has been
 * supplied yet (PRD-806 ground rules); the level names and "Current level" are
 * ISS-12523's shipped copy, rendered by `DataSyncPolicySummary`.
 */

/**
 * The policy a desktop reported.
 *
 * NOT THE WIRE CONTRACT. When the per-device report API lands, the PR that
 * adds it must define this shape in `packages/api/src/types` with a Zod
 * parser at the boundary, and this component then imports it from there. The
 * API must not import this type from a component file: the UI would end up
 * defining the contract.
 */
export type DeviceReportedDataPolicy = {
  /**
   * The level in force on the device. Never null here: a device that has not
   * saved a choice has nothing to report, so its `policy` is null instead.
   * That keeps `DataSyncPolicySummary`'s device-local unset message, which
   * asks the reader to choose a level, off web, where no level can be chosen.
   */
  level: DataSyncLevel;
  /**
   * How many directories the policy covers, as the device counted them.
   * Supplied rather than derived from `scope`: an included parent covers its
   * whole subtree, so counting ids would not match what the device collects.
   * Omitted when the device did not report one.
   */
  directoryCount?: number;
  /** Which directories are in scope. Omitted when the device did not report it. */
  scope?: {
    entries: readonly DirectoryScopeEntry[];
    includedIds: readonly string[];
    autoExcluded?: readonly AutoExcludedDirectory[];
  };
};

export type DeviceDataPolicyCopy = {
  /** Status label when the device has reported a policy. */
  reported: string;
  /** Status label when it has not (AC-002). */
  unreported: string;
  /** Label of the summary's directory-count row. */
  directoryScope: string;
  /** Label of the summary's machine and organization row. */
  appliesTo: string;
  /** Why the scope list cannot be changed here. */
  scopeReadOnlyReason: string;
  /** The scope list's own words (ISS-12520). */
  scopeList: DirectoryScopeListCopy;
};

export type DeviceDataPolicyProps = {
  /** The device's name, as its compute target reports it. */
  machineName: string;
  orgName?: string;
  /** Null when the device has reported no policy (AC-002). */
  policy: DeviceReportedDataPolicy | null;
  copy: DeviceDataPolicyCopy;
  className?: string;
};

export function DeviceDataPolicy({
  machineName,
  orgName,
  policy,
  copy,
  className,
}: DeviceDataPolicyProps) {
  if (policy === null) {
    return (
      <div
        className={cn("flex flex-col gap-2", className)}
        data-device-data-policy="unreported"
      >
        <PolicyStatusIndicator
          detail={machineName}
          label={copy.unreported}
          status={POLICY_STATUS.UNAVAILABLE}
        />
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      data-device-data-policy="reported"
    >
      <PolicyStatusIndicator
        label={copy.reported}
        status={POLICY_STATUS.ACTIVE}
      />
      <DataSyncPolicySummary
        appliesTo={{ label: copy.appliesTo, machineName, orgName }}
        directoryScope={
          policy.directoryCount === undefined
            ? undefined
            : { count: policy.directoryCount, label: copy.directoryScope }
        }
        level={policy.level}
      />
      {policy.scope ? (
        <DirectoryScopeList
          autoExcluded={policy.scope.autoExcluded}
          copy={copy.scopeList}
          entries={policy.scope.entries}
          includedIds={policy.scope.includedIds}
          readOnlyReason={copy.scopeReadOnlyReason}
        />
      ) : null}
    </div>
  );
}
