/**
 * Canonical status set for the Desktop-first browser-approval device session
 * state machine (`apps/api/app/desktop/device-onboarding/service.ts`). Shared
 * with the web approval UI (`useDesktopDeviceSession`), which gates its
 * approve/deny buttons on the `pending` value — so the contract lives here in
 * `@repo/api/src/types` rather than co-located in `apps/api`.
 */
export const DesktopDeviceSessionStatus = {
  Pending: "pending",
  Approved: "approved",
  Denied: "denied",
  Expired: "expired",
} as const;
export type DesktopDeviceSessionStatus =
  (typeof DesktopDeviceSessionStatus)[keyof typeof DesktopDeviceSessionStatus];

export const OnboardingStep = {
  Welcome: "WELCOME",
  CreateTeam: "CREATE_TEAM",
  CreateProject: "CREATE_PROJECT",
  ConnectGitHub: "CONNECT_GITHUB",
  AddAnthropicKey: "ADD_ANTHROPIC_KEY",
  ConnectOptionalIntegrations: "CONNECT_OPTIONAL_INTEGRATIONS",
  DownloadElectronApp: "DOWNLOAD_ELECTRON_APP",
  InviteTeammates: "INVITE_TEAMMATES",
  Complete: "COMPLETE",
} as const;
export type OnboardingStep =
  (typeof OnboardingStep)[keyof typeof OnboardingStep];

export type OnboardingState = {
  wizardCompletedAt: string | null;
  wizardCompletedBy: string | null;
  checklistDismissedAt: string | null;
  createdTeamId: string | null;
  createdProjectId: string | null;
};

export type OnboardingStatus = {
  wizardCompleted: boolean;
  checklistDismissed: boolean;
  checklist: OnboardingChecklistItem[];
};

export const ChecklistItemId = {
  CreateTeam: "CREATE_TEAM",
  CreateProject: "CREATE_PROJECT",
  ConnectGitHub: "CONNECT_GITHUB",
  AddAnthropicKey: "ADD_ANTHROPIC_KEY",
  ConnectGoogle: "CONNECT_GOOGLE",
  InviteMembers: "INVITE_MEMBERS",
} as const;
export type ChecklistItemId =
  (typeof ChecklistItemId)[keyof typeof ChecklistItemId];

export type OnboardingChecklistItem = {
  id: ChecklistItemId;
  label: string;
  description: string;
  completed: boolean;
  href?: string;
};
