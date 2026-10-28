"use client";

import type { ScenarioPanelCondition } from "@repo/app/shell/v2/components/prototype-scenario-panel";
import { PrototypeScenarioPanel } from "@repo/app/shell/v2/components/prototype-scenario-panel";
import {
  Code2Icon,
  DatabaseIcon,
  EyeIcon,
  Globe2Icon,
  LaptopIcon,
  MonitorIcon,
  RotateCcwIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo } from "react";

const MODE_STORAGE_KEY = "closedloop-prototype-mode";
const ANNOTATIONS_STORAGE_KEY = "closedloop-prototype-annotations";
const POSITION_STORAGE_KEY = "closedloop-prototype-menu-position";
const USER_SCENARIO_STORAGE_KEY = "closedloop-prototype-user-scenario";
const ORGANIZATION_DATA_PROBE_STORAGE_KEY =
  "closedloop-prototype-organization-data-probe";

export const PrototypeMode = {
  Desktop: "desktop",
  Web: "web",
} as const;
export type PrototypeMode = (typeof PrototypeMode)[keyof typeof PrototypeMode];

export const PrototypeUserScenario = {
  First: "first-user",
  FiftyFirst: "51st-user",
} as const;
export type PrototypeUserScenario =
  (typeof PrototypeUserScenario)[keyof typeof PrototypeUserScenario];

/**
 * Whether the organization's synced-data flag was ever READ, which is a
 * different axis from what it says. `Unmeasured` is the only fixture that
 * reaches the download step's `Unknown` skip-eligibility arm, and that arm is
 * the one ISS-8350 exists for — a failed server probe, an
 * absent field, or a host that never supplied the value. The user-position
 * toggle above cannot produce it: it maps to a member count, and a count always
 * answers yes or no.
 */
export const PrototypeOrganizationDataProbe = {
  Measured: "measured",
  Unmeasured: "unmeasured",
} as const;
export type PrototypeOrganizationDataProbe =
  (typeof PrototypeOrganizationDataProbe)[keyof typeof PrototypeOrganizationDataProbe];

/**
 * What the download step's platform read answers (ISS-12364). `Detected` leaves
 * the step to read the browser's own; the Windows options force the platform
 * with no published installer, where the "notify me" email capture renders, and
 * pick whether its mock request succeeds or fails.
 */
export const PrototypePlatform = {
  Detected: "detected",
  Windows: "windows",
  WindowsRequestFails: "windows-request-fails",
} as const;
export type PrototypePlatform =
  (typeof PrototypePlatform)[keyof typeof PrototypePlatform];

function isPrototypePlatform(value: string): value is PrototypePlatform {
  return (Object.values(PrototypePlatform) as string[]).includes(value);
}

export const PrototypeAnnotations = {
  Hide: "hide",
  Show: "show",
} as const;
export type PrototypeAnnotations =
  (typeof PrototypeAnnotations)[keyof typeof PrototypeAnnotations];

function isPrototypeMode(value: string): value is PrototypeMode {
  return value === PrototypeMode.Desktop || value === PrototypeMode.Web;
}

function isPrototypeUserScenario(
  value: string
): value is PrototypeUserScenario {
  return (
    value === PrototypeUserScenario.First ||
    value === PrototypeUserScenario.FiftyFirst
  );
}

function isPrototypeOrganizationDataProbe(
  value: string
): value is PrototypeOrganizationDataProbe {
  return (
    value === PrototypeOrganizationDataProbe.Measured ||
    value === PrototypeOrganizationDataProbe.Unmeasured
  );
}

function isPrototypeAnnotations(value: string): value is PrototypeAnnotations {
  return (
    value === PrototypeAnnotations.Show || value === PrototypeAnnotations.Hide
  );
}

function publishMode(mode: PrototypeMode) {
  globalThis.document.documentElement.dataset.prototypeMode = mode;
  globalThis.window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  globalThis.window.dispatchEvent(
    new CustomEvent("prototype-mode-change", { detail: { mode } })
  );
}

function publishAnnotations(annotations: PrototypeAnnotations) {
  globalThis.document.documentElement.dataset.prototypeAnnotations =
    annotations;
  globalThis.window.localStorage.setItem(ANNOTATIONS_STORAGE_KEY, annotations);
  globalThis.window.dispatchEvent(
    new CustomEvent("prototype-annotations-change", {
      detail: { annotations },
    })
  );
}

/** Prototype-only control for previewing one shared surface in either host. */
export function PrototypeDeveloperMenu({
  onAnnotationsChange,
  onModeChange,
  onOrganizationDataProbeChange,
  onOrganizationMemberCountChange,
  onPlatformChange,
  onResetOnboarding,
  onSimulateDesktopSyncChoice,
}: {
  onAnnotationsChange?: (annotations: PrototypeAnnotations) => void;
  onModeChange?: (mode: PrototypeMode) => void;
  onOrganizationDataProbeChange?: (
    probe: PrototypeOrganizationDataProbe
  ) => void;
  onOrganizationMemberCountChange?: (count: number) => void;
  /** ISS-12364: what the download step's platform read answers. */
  onPlatformChange?: (platform: PrototypePlatform) => void;
  onResetOnboarding?: () => void;
  /**
   * Web only (ISS-12363): records a sync policy as if it were chosen in Desktop,
   * to show the web gate resolving from the other surface.
   */
  onSimulateDesktopSyncChoice?: () => void;
} = {}) {
  const conditions = useMemo<readonly ScenarioPanelCondition[]>(
    () => [
      {
        ariaLabel: "Prototype mode",
        default: PrototypeMode.Desktop,
        icon: Code2Icon,
        id: "mode",
        label: "Mode:",
        onChange: (value) => {
          if (!isPrototypeMode(value)) {
            return;
          }
          publishMode(value);
          onModeChange?.(value);
        },
        options: [
          {
            ariaLabel: "Desktop mode",
            icon: MonitorIcon,
            label: "Desktop",
            value: PrototypeMode.Desktop,
          },
          {
            ariaLabel: "Web mode",
            icon: Globe2Icon,
            label: "Web",
            value: PrototypeMode.Web,
          },
        ],
        storageKey: MODE_STORAGE_KEY,
      },
      {
        ariaLabel: "Prototype user position",
        default: PrototypeUserScenario.First,
        icon: UsersIcon,
        id: "user-scenario",
        label: "User:",
        onChange: (value) => {
          if (!isPrototypeUserScenario(value)) {
            return;
          }
          onOrganizationMemberCountChange?.(
            value === PrototypeUserScenario.First ? 0 : 50
          );
        },
        options: [
          {
            ariaLabel: "First user",
            label: "First user",
            value: PrototypeUserScenario.First,
          },
          {
            ariaLabel: "51st user",
            label: "51st user",
            value: PrototypeUserScenario.FiftyFirst,
          },
        ],
        storageKey: USER_SCENARIO_STORAGE_KEY,
      },
      {
        ariaLabel: "Prototype organization data probe",
        default: PrototypeOrganizationDataProbe.Measured,
        icon: DatabaseIcon,
        id: "organization-data-probe",
        label: "Org data:",
        onChange: (value) => {
          if (!isPrototypeOrganizationDataProbe(value)) {
            return;
          }
          onOrganizationDataProbeChange?.(value);
        },
        options: [
          {
            ariaLabel: "Organization data measured",
            label: "Measured",
            value: PrototypeOrganizationDataProbe.Measured,
          },
          {
            ariaLabel: "Organization data unmeasured",
            label: "Unmeasured",
            value: PrototypeOrganizationDataProbe.Unmeasured,
          },
        ],
        storageKey: ORGANIZATION_DATA_PROBE_STORAGE_KEY,
      },
      {
        ariaLabel: "Prototype platform",
        default: PrototypePlatform.Detected,
        icon: LaptopIcon,
        id: "platform",
        label: "Platform:",
        onChange: (value) => {
          if (!isPrototypePlatform(value)) {
            return;
          }
          onPlatformChange?.(value);
        },
        options: [
          {
            ariaLabel: "Detected platform",
            label: "Detected",
            value: PrototypePlatform.Detected,
          },
          {
            ariaLabel: "Windows, notify request succeeds",
            label: "Windows",
            value: PrototypePlatform.Windows,
          },
          {
            ariaLabel: "Windows, notify request fails",
            label: "Win, fails",
            value: PrototypePlatform.WindowsRequestFails,
          },
        ],
      },
      {
        ariaLabel: "Prototype annotations",
        default: PrototypeAnnotations.Show,
        icon: EyeIcon,
        id: "annotations",
        label: "Design Notes:",
        onChange: (value) => {
          if (!isPrototypeAnnotations(value)) {
            return;
          }
          publishAnnotations(value);
          onAnnotationsChange?.(value);
        },
        options: [
          {
            ariaLabel: "Show annotations",
            label: "Show",
            value: PrototypeAnnotations.Show,
          },
          {
            ariaLabel: "Hide annotations",
            label: "Hide",
            value: PrototypeAnnotations.Hide,
          },
        ],
        storageKey: ANNOTATIONS_STORAGE_KEY,
      },
    ],
    [
      onAnnotationsChange,
      onModeChange,
      onOrganizationDataProbeChange,
      onOrganizationMemberCountChange,
      onPlatformChange,
    ]
  );

  const actions = useMemo(() => {
    const list: {
      label: string;
      icon: typeof MonitorIcon;
      onClick: () => void;
    }[] = [];
    if (onSimulateDesktopSyncChoice) {
      list.push({
        icon: MonitorIcon,
        label: "Simulate sync choice in Desktop",
        onClick: onSimulateDesktopSyncChoice,
      });
    }
    if (onResetOnboarding) {
      list.push({
        icon: RotateCcwIcon,
        label: "Reset onboarding state",
        onClick: onResetOnboarding,
      });
    }
    return list;
  }, [onResetOnboarding, onSimulateDesktopSyncChoice]);

  return (
    <PrototypeScenarioPanel
      actions={actions}
      ariaLabel="Prototype developer controls"
      conditions={conditions}
      positionStorageKey={POSITION_STORAGE_KEY}
    />
  );
}
