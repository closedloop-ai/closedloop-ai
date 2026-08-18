"use client";

import { ListChecksIcon } from "lucide-react";
import { useState } from "react";
import type { ChecklistItemId, SettingsTarget } from "../mock";
import { InviteSpotlight } from "./invite-spotlight";
import { InviteTeamDialog } from "./invite-team-dialog";
import { OnboardingChecklist } from "./onboarding-checklist";

type MyTasksPageProps = {
  checklistCompletion: Partial<Record<ChecklistItemId, boolean>>;
  checklistDismissed: boolean;
  onDismissChecklist: () => void;
  inviteDismissed: boolean;
  onDismissInvite: () => void;
  onInvited: () => void;
  onDesktopInstalled: () => void;
  onOpenSettings: (target: SettingsTarget) => void;
};

// The page a new user lands on after onboarding. Presentational stand-in for the
// production My Tasks page: the "Complete Your Setup" checklist over an empty
// task queue, with the invite spotlight nudging the last open step. The
// production Set-up-AI-agents card is intentionally not rendered.
export const MyTasksPage = ({
  checklistCompletion,
  checklistDismissed,
  onDismissChecklist,
  inviteDismissed,
  onDismissInvite,
  onInvited,
  onDesktopInstalled,
  onOpenSettings,
}: MyTasksPageProps) => {
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {checklistDismissed ? null : (
        <OnboardingChecklist
          completion={checklistCompletion}
          onDismiss={onDismissChecklist}
          onDownloadDesktop={onDesktopInstalled}
          onNavigate={onOpenSettings}
        />
      )}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <ListChecksIcon className="size-6 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-lg tracking-tight">No tasks yet</h2>
          <p className="text-muted-foreground text-sm">
            Tasks assigned to you across your projects show up here. Finish
            setting up your workspace to get started.
          </p>
        </div>
      </div>
      <InviteSpotlight
        active={!(checklistDismissed || inviteDismissed)}
        onDismiss={onDismissInvite}
        onInvite={() => {
          onDismissInvite();
          setInviteDialogOpen(true);
        }}
      />
      {/* Owned here, not inside the spotlight, so opening it can dismiss the
          spotlight without unmounting the dialog. */}
      <InviteTeamDialog
        onInvited={onInvited}
        onOpenChange={setInviteDialogOpen}
        open={inviteDialogOpen}
      />
    </div>
  );
};
