"use client";

import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { Building2Icon } from "lucide-react";
import { lazy } from "react";
import { SettingsPanelSection } from "../../components/settings-panel-section";
import { defineSettingsPanel } from "../../lib/settings-panel-registry";

// Lazy so the form, its three data hooks and `zod` stay out of the Settings
// entry bundle — the registry's stated contract, and the shell already supplies
// the Suspense and error boundaries a lazy body needs. It also keeps the card's
// web-only workspace-URL host out of any module a non-web shell evaluates.
const OrganizationProfileCard = lazy(() =>
  import("./organization-profile-card").then((module) => ({
    default: module.OrganizationProfileCard,
  }))
);

// ISS-10244 retired `settings-v2-organization-panel`. The panel shipped, so the
// gate is gone rather than opened, and with it the "not switched on yet" screen
// that was the flag's closed shape.
function OrganizationGeneralPanel() {
  return (
    <SettingsPanelSection
      description="Manage the company profile shared across Closedloop."
      title="General"
    >
      <OrganizationProfileCard />
    </SettingsPanelSection>
  );
}

/**
 * Settings v2 → Organization → **General** (ISS-8365).
 *
 * `requiredCapability` is `Read`, not `Admin`, and that is the policy speaking
 * rather than a looser guess: `SETTINGS_DOMAIN_ACCESS_POLICY[Organization]`
 * grants read AND edit to every role, because a member renaming their own
 * organization is a capability that exists today and withdrawing it is a
 * product decision ISS-8378 deliberately declined to make. The one control that
 * IS admin-gated at the route — the slug — is gated on the `admin` rung inside
 * the body, which is where a per-control gate belongs.
 *
 * Web-only: the organization URL is a web-URL concept, and the desktop renderer
 * has no URL-visible organization. Desktop registers this descriptor like every
 * other and resolves it to `unavailable`, which is a different fact from a
 * denial and renders as its own screen.
 */
export const organizationGeneralPanel = defineSettingsPanel({
  hosts: [SettingsPanelHost.Web],
  icon: Building2Icon,
  id: SettingsPanelId.OrganizationGeneral,
  Panel: OrganizationGeneralPanel,
  requiredCapability: SettingsPanelCapability.Read,
});
