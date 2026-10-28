"use client";

import { FeatureFlagged } from "../../../shared/feature-flags/feature-flagged";
import { GOOGLE_DRIVE_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { SettingsPanelSection } from "../components/settings-panel-section";
import { GoogleDriveCard } from "./plugins/google-drive-card";
import { useGoogleOAuthCallbackOutcome } from "./plugins/use-google-oauth-callback-outcome";

/**
 * The Settings v2 Plugins panel (ISS-8369).
 *
 * SCOPE. Google Drive is {@link GoogleDriveCard}, mounted behind
 * `google-drive` (ISS-10316), and this panel also reports the `?google=` OAuth
 * outcome, which the deep-link adapter routes here. GitHub is not here:
 * Profile › Sign-in methods owns that connection. Linear's connection card was
 * removed with Export to Linear (ISS-12856).
 *
 * WEB-ONLY BY CONSTRUCTION. Connecting starts a browser OAuth redirect to a web
 * app route. A desktop renderer would need a system browser plus a loopback
 * callback, which does not exist, so the descriptor declares `hosts: [web]` and
 * desktop gets the registry's honest `unavailable` screen instead of a Connect
 * button that cannot work.
 */
export function PluginsSettingsPanel() {
  useGoogleOAuthCallbackOutcome();

  return (
    <SettingsPanelSection
      description="Connect the tools you use to give your sessions more context."
      title="Plugins"
    >
      <FeatureFlagged flag={GOOGLE_DRIVE_FEATURE_FLAG_KEY}>
        <GoogleDriveCard />
      </FeatureFlagged>
    </SettingsPanelSection>
  );
}
