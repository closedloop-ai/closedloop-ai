import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { BadgeCheckIcon } from "lucide-react";
import { lazy } from "react";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "../../lib/settings-panel-registry";

/**
 * Settings v2 → Labs → Compliance (ISS-8367).
 *
 * `requiredCapability` is `Read` even though only an admin or owner may open
 * this panel, and that is deliberate: the denial is already produced by
 * `SETTINGS_DOMAIN_ACCESS_POLICY[Compliance].read`, which lists only Admin and
 * Owner, so a member's projection carries no capability for this panel at all
 * and resolves to `Forbidden` whatever the descriptor asks for. Writing `Admin`
 * here would be the same rule stated twice — and the copy that goes stale the
 * day the policy row moves.
 */
export const complianceSettingsPanel: SettingsPanelDescriptor =
  defineSettingsPanel({
    hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
    icon: BadgeCheckIcon,
    id: SettingsPanelId.Compliance,
    Panel: lazy(async () => ({
      default: (await import("./compliance-panel")).CompliancePanel,
    })),
    requiredCapability: SettingsPanelCapability.Read,
  });
