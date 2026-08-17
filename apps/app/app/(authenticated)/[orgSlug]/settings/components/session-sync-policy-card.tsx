"use client";

import { OrgPolicyField } from "@repo/app/settings/lib/org-policy-toggle-state";
import { OrgPolicyToggleCard } from "./org-policy-toggle-card";

const TOGGLE_ID = "session-sync-policy-enabled";

const CARD_TITLE = "Sync session data to the cloud";

const CARD_DESCRIPTION =
  "Control whether this organization's locally-captured agent-session data is allowed to sync to the ClosedLoop cloud.";

const TOGGLE_LABEL = "Allow session data to sync to the cloud";

const TOGGLE_HELP_TEXT =
  "Off by default. When off, new session data stays on each member's machine; work already in progress may finish syncing.";

type SessionSyncPolicyCardProperties = {
  isAdmin: boolean;
};

/**
 * Admin-only toggle for the org session-sync privacy policy (FEA-4169).
 * Governs whether this organization's locally-captured agent-session data
 * (session metadata, transcripts, and trace-comment sync) is allowed to sync
 * from the desktop app to the ClosedLoop cloud. Off by default and fail-closed
 * on the server — no local session data leaves the machine until an admin opts
 * in. The API enforces the same admin check before persisting, and the server
 * re-enforces the policy at every ingest boundary regardless of client version.
 *
 * The card body (including the unavailable state a previous-generation API
 * produces, ISS-4624) lives in the shared `OrgPolicyToggleCard`.
 */
export function SessionSyncPolicyCard({
  isAdmin,
}: Readonly<SessionSyncPolicyCardProperties>) {
  return (
    <OrgPolicyToggleCard
      description={CARD_DESCRIPTION}
      field={OrgPolicyField.SessionSyncPolicyEnabled}
      isAdmin={isAdmin}
      title={CARD_TITLE}
      toggleHelpText={TOGGLE_HELP_TEXT}
      toggleId={TOGGLE_ID}
      toggleLabel={TOGGLE_LABEL}
    />
  );
}
