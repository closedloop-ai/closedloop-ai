/**
 * @file Fixtures for `DeviceDataPolicy` (ISS-12531), read by its stories and
 * the `data-controls-device-policy-web` prototype. No shipped render path
 * imports this module.
 *
 * Every device, organization and directory is fictional. Every string is a
 * placeholder named after its copy slot, never product wording. Placeholders
 * in design-only fixtures are allowed by operator ruling (Nerys, 2026-10-15),
 * thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the wording. The
 * proposed wording lives on the ISS-12531 ticket thread, not here.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type {
  DeviceDataPolicyCopy,
  DeviceReportedDataPolicy,
} from "./device-data-policy";

export const DEVICE_DATA_POLICY_PLACEHOLDER_COPY: DeviceDataPolicyCopy = {
  appliesTo: "Placeholder: applies to label",
  directoryScope: "Placeholder: directories in scope label",
  reported: "Placeholder: reported status",
  scopeList: {
    autoExcludedHeading: "Placeholder: auto-excluded heading",
    autoExcludedReason: "Placeholder: auto-excluded reason",
    empty: "Placeholder: empty",
    newlyDiscovered: "Placeholder: new badge",
    noSelection: "Placeholder: no selection",
    treeLabel: "Placeholder: tree label",
    unavailable: "Placeholder: unavailable badge",
    unavailableReason: "Placeholder: unavailable reason",
  },
  scopeReadOnlyReason: "Placeholder: read-only scope reason",
  unreported: "Placeholder: not reported status",
};

export const FIXTURE_ORG_NAME = "Orbit Labs";

export const FIXTURE_REPORTED_POLICY: DeviceReportedDataPolicy = {
  directoryCount: 2,
  level: DataSyncLevel.Full,
  scope: {
    autoExcluded: [
      { id: "~/Desktop", label: "~/Desktop" },
      { id: "~/Documents", label: "~/Documents" },
      { id: "~/Downloads", label: "~/Downloads" },
    ],
    entries: [
      {
        id: "~/code",
        label: "~/code",
        children: [
          { id: "~/code/orbit-api", label: "orbit-api" },
          { id: "~/code/orbit-web", label: "orbit-web" },
        ],
      },
      { id: "~/sandbox", label: "~/sandbox" },
    ],
    includedIds: ["~/code"],
  },
};

/** The level alone: a device that reported no directory count or list. */
export const FIXTURE_LEVEL_ONLY_POLICY: DeviceReportedDataPolicy = {
  level: DataSyncLevel.Metadata,
};

export const FIXTURE_DEVICES = [
  {
    id: "device-studio",
    machineName: "Studio Mac",
    policy: FIXTURE_REPORTED_POLICY,
  },
  {
    id: "device-travel",
    machineName: "Travel MacBook",
    policy: FIXTURE_LEVEL_ONLY_POLICY,
  },
  { id: "device-lab", machineName: "Lab Mac mini", policy: null },
] as const;
