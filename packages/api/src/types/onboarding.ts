export const OnboardingStep = {
  Welcome: "WELCOME",
  CreateTeam: "CREATE_TEAM",
  CreateProject: "CREATE_PROJECT",
  ConnectGitHub: "CONNECT_GITHUB",
  AddAnthropicKey: "ADD_ANTHROPIC_KEY",
  ConnectOptionalIntegrations: "CONNECT_OPTIONAL_INTEGRATIONS",
  DownloadElectronApp: "DOWNLOAD_ELECTRON_APP",
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
  ConnectLinear: "CONNECT_LINEAR",
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
