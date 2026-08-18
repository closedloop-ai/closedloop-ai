"use client";

import { ConnectGitHubPrompt } from "./connect-github-prompt";
import { SyncConsent, type SyncConsentLevel } from "./sync-consent";

type AccountSetupFlowProps = {
  /** Whether the user's GitHub App connection is already established. */
  githubConnected: boolean;
  /** Runs the real GitHub App connect/authorize flow (host-wired). */
  onConnect: () => void;
  /** In-flight state for the connect step. */
  connecting?: boolean;
  /** Fired with the chosen data-sync level once the user confirms consent. */
  onComplete: (level: SyncConsentLevel) => void;
  /** In-flight state for the sync-consent confirm. */
  confirming?: boolean;
  /**
   * Applied to whichever step's heading is currently on screen, so a host that
   * owns the surrounding surface can name it from the visible heading rather
   * than a copy that goes stale as the flow advances (ISS-5112).
   */
  headingId?: string;
};

/**
 * The unified post-sign-in account-setup flow (PRD-532): GitHub App install →
 * sync consent. Driven by `githubConnected` (host-owned): the connect
 * step is shown until GitHub is connected, then the sync-consent step. Because
 * the GitHub connection is org+user-scoped and connect-once, a user who already
 * connected on another surface skips straight to sync consent. Surface-agnostic:
 * the host wires `onConnect` to the platform connect flow and `onComplete` to
 * persist the tier + finish setup.
 */
export function AccountSetupFlow({
  githubConnected,
  onConnect,
  connecting = false,
  onComplete,
  confirming = false,
  headingId,
}: AccountSetupFlowProps) {
  if (githubConnected) {
    return (
      <SyncConsent
        confirming={confirming}
        headingId={headingId}
        onConfirm={onComplete}
      />
    );
  }
  return (
    <ConnectGitHubPrompt
      connecting={connecting}
      headingId={headingId}
      onConnect={onConnect}
    />
  );
}
