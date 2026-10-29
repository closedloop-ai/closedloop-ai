/**
 * @file settings-navigation-model.ts
 * @description Pure derivation of what Settings navigation offers, so the
 * ordering and the omission rules are testable without rendering.
 *
 * Which entries are OMITTED is the load-bearing decision here. `forbidden` and
 * `unavailable` are authoritative answers, so those panels are dropped. A
 * `pending` or `capability-error` panel is NOT dropped: omitting it would turn
 * a read that never completed into the claim "this does not exist for you",
 * which is the failed-read-becomes-an-empty-state collapse PRD-692 forbids.
 * Those entries render as themselves and are not navigable.
 */
import {
  SETTINGS_PANEL_GROUP_MEMBERS,
  SETTINGS_PANEL_GROUP_ORDER,
  SettingsActorCapabilityStatus,
  type SettingsPanelGroup,
  type SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import {
  evaluateSettingsPanelStatus,
  type ResolveSettingsPanelInput,
} from "./settings-panel-resolution";

export type SettingsNavigationEntry = {
  id: SettingsPanelId;
  status: SettingsPanelResolutionStatus;
  navigable: boolean;
  /**
   * True only when the surface-wide read SUCCEEDED and this one panel came back
   * unreadable, which is the only case where the row is the sole place that
   * fact can live. A whole-read failure is one fact about the surface, already
   * stated once in the panel area, so it is not restated on every row.
   */
  ownsCapabilityError: boolean;
};

export type SettingsNavigationGroupModel = {
  group: SettingsPanelGroup;
  entries: readonly SettingsNavigationEntry[];
};

type SettingsNavigationPolicy = {
  /** Whether the panel gets a navigation row at all. */
  offered: boolean;
  /** Whether that row is a link rather than inert text. */
  navigable: boolean;
};

/**
 * Exhaustive by type, so adding a `SettingsPanelResolutionStatus` fails `tsc`
 * here until someone decides what the nav does with it. A partial list would
 * instead drop the new status silently — the panel would vanish from the nav
 * with nothing red to say so, which is the same failed-read-becomes-an-absence
 * collapse the omission rules above exist to prevent.
 */
const SETTINGS_NAVIGATION_POLICY: Record<
  SettingsPanelResolutionStatus,
  SettingsNavigationPolicy
> = {
  [SettingsPanelResolutionStatus.Ready]: { navigable: true, offered: true },
  [SettingsPanelResolutionStatus.Pending]: { navigable: false, offered: true },
  [SettingsPanelResolutionStatus.CapabilityError]: {
    navigable: false,
    offered: true,
  },
  [SettingsPanelResolutionStatus.Unknown]: { navigable: false, offered: false },
  [SettingsPanelResolutionStatus.Unavailable]: {
    navigable: false,
    offered: false,
  },
  [SettingsPanelResolutionStatus.Forbidden]: {
    navigable: false,
    offered: false,
  },
};

export function buildSettingsNavigationModel(
  context: Omit<ResolveSettingsPanelInput, "requestedPanel">
): readonly SettingsNavigationGroupModel[] {
  const models: SettingsNavigationGroupModel[] = [];

  for (const group of SETTINGS_PANEL_GROUP_ORDER) {
    const entries: SettingsNavigationEntry[] = [];
    for (const id of SETTINGS_PANEL_GROUP_MEMBERS[group]) {
      const status = evaluateSettingsPanelStatus(id, context);
      const policy = SETTINGS_NAVIGATION_POLICY[status];
      if (policy.offered) {
        entries.push({
          id,
          status,
          navigable: policy.navigable,
          ownsCapabilityError:
            status === SettingsPanelResolutionStatus.CapabilityError &&
            context.capabilities.status !== SettingsActorCapabilityStatus.Error,
        });
      }
    }
    if (entries.length > 0) {
      models.push({ group, entries });
    }
  }

  return models;
}
