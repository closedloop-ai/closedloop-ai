"use client";

import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { FeatureFlagged } from "../../../../shared/feature-flags/feature-flagged";
import { PENSERO_INTEGRATION_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { useSettingsAdminGate } from "../../hooks/use-settings-admin-gate";
import { PenseroCredentialCard } from "./pensero-credential-card";

/**
 * The third-party credential the API Keys panel holds beside Closedloop's own
 * keys (ISS-10316): the org's Pensero credential behind its rollout flag. Its
 * write is gated by the `Connections` route, so the card asks that domain for
 * the admin rung.
 */
export function ApiKeysCredentialCards() {
  return (
    <FeatureFlagged flag={PENSERO_INTEGRATION_FEATURE_FLAG_KEY}>
      <PenseroCredentialSection />
    </FeatureFlagged>
  );
}

function PenseroCredentialSection() {
  const gate = useSettingsAdminGate(SettingsDomainId.Connections);
  return (
    <PenseroCredentialCard
      accessState={gate.accessState}
      isAdmin={gate.isAdmin}
      onAccessRetry={gate.onRetry}
    />
  );
}
