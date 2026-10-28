"use client";

import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { OrganizationDetails } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { createContext, useContext } from "react";
import type { SyncPolicy } from "./guided-ftue-modal";
import type { PrototypeMode } from "./prototype-developer-menu";

export type WebMasterPrototypeContextValue = {
  accountMethod: AuthMethod | null;
  accountSkipped: boolean;
  desktopAppDownloaded: boolean;
  githubConnected: boolean;
  organizationDetails: OrganizationDetails;
  organizationHasSessionData: boolean;
  invitedEmails: readonly string[];
  mode: PrototypeMode;
  // The one sync preference the prototype owns. Onboarding sets it and Settings
  // edits the same value, so the two surfaces can never disagree about what this
  // device is syncing. `null` until the reader has chosen (ISS-12363).
  syncPolicy: SyncPolicy | null;
  teamInvited: boolean;
  connectGitHub: () => void;
  disconnectGitHub: () => void;
  downloadDesktopApp: () => void;
  inviteTeam: (emails: readonly string[]) => void;
  openAccountSetup: () => void;
  openGitHubSetup: () => void;
  setOrganizationDetails: (organization: OrganizationDetails) => void;
  setSyncPolicy: (policy: SyncPolicy) => void;
  /** Records a policy as if the reader chose it in Desktop (ISS-12363). */
  simulateDesktopSyncChoice: () => void;
};

const WebMasterPrototypeContext =
  createContext<WebMasterPrototypeContextValue | null>(null);

export const WebMasterPrototypeProvider = WebMasterPrototypeContext.Provider;

export function useWebMasterPrototype() {
  const value = useContext(WebMasterPrototypeContext);
  if (!value) {
    throw new Error(
      "useWebMasterPrototype must be used inside WebMasterPrototypeProvider"
    );
  }
  return value;
}
