"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Card } from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { CableIcon } from "lucide-react";
import { useState } from "react";
import {
  type ActivityRow,
  AppRoute,
  type AppRoute as AppRouteType,
  activityTotals,
  ChecklistItemId,
  recentBranches,
  recentSessions,
  SettingsTab,
  type SettingsTarget,
} from "../mock";
import { ActivityCard } from "./activity-card";
import { Dashboard } from "./dashboard";
import { MyTasksPage } from "./my-tasks-page";
import { SettingsPage } from "./settings-page";
import { WorkspaceSidebar } from "./workspace-sidebar";

type WebAppShellProps = {
  workspaceName: string;
  projectName: string;
  projectDescription?: string;
};

// The authenticated app the user lands on after onboarding. Default route is My
// Tasks (where the setup checklist and invite spotlight live); Dashboard,
// Sessions, and Branches stay reachable so the sidebar reads honestly.
export const WebAppShell = ({
  workspaceName,
  projectName,
  projectDescription,
}: WebAppShellProps) => {
  const [route, setRoute] = useState<AppRouteType>(AppRoute.MyTasks);
  // First-run signals — start false, flip as the user completes each step, so
  // the checklist and the surfaces below it agree with each other.
  const [desktopInstalled, setDesktopInstalled] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [teamInvited, setTeamInvited] = useState(false);
  // A brand-new workspace has no data yet; the populated dashboard/sessions/
  // branches are a demo the reviewer can toggle on, not the default.
  const [showDemoData, setShowDemoData] = useState(false);
  const [checklistDismissed, setChecklistDismissed] = useState(false);
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(
    null
  );
  // Bumped per navigation so the deep-linked Settings surface remounts and
  // re-applies its target tab / section / anchor scroll each time.
  const [settingsNonce, setSettingsNonce] = useState(0);

  const openSettings = (target: SettingsTarget) => {
    setSettingsTarget(target);
    setSettingsNonce((nonce) => nonce + 1);
    setRoute(AppRoute.Settings);
  };

  const checklistCompletion = {
    [ChecklistItemId.DownloadDesktop]: desktopInstalled,
    [ChecklistItemId.ConnectGitHub]: githubConnected,
    [ChecklistItemId.AddAnthropicKey]: apiKeySaved,
    [ChecklistItemId.InviteMembers]: teamInvited,
  };
  const enableDemo = () => setShowDemoData(true);
  const disableDemo = () => setShowDemoData(false);

  return (
    <SidebarProvider className="h-svh">
      <WorkspaceSidebar
        activeRoute={route}
        branchCount={showDemoData ? activityTotals.branches : undefined}
        onInvited={() => setTeamInvited(true)}
        onNavigate={setRoute}
        onOpenSettings={() => openSettings({ tab: SettingsTab.Profile })}
        projectDescription={projectDescription}
        projectName={projectName}
        sessionCount={showDemoData ? activityTotals.sessions : undefined}
        workspaceName={workspaceName}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <AppHeader route={route} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {route === AppRoute.MyTasks ? (
            <MyTasksPage
              checklistCompletion={checklistCompletion}
              checklistDismissed={checklistDismissed}
              inviteDismissed={inviteDismissed}
              onDesktopInstalled={() => setDesktopInstalled(true)}
              onDismissChecklist={() => setChecklistDismissed(true)}
              onDismissInvite={() => setInviteDismissed(true)}
              onInvited={() => setTeamInvited(true)}
              onOpenSettings={openSettings}
            />
          ) : null}
          {route === AppRoute.Settings ? (
            <SettingsPage
              apiKeySaved={apiKeySaved}
              githubConnected={githubConnected}
              key={settingsNonce}
              onConnectGitHub={() => setGithubConnected(true)}
              onInvited={() => setTeamInvited(true)}
              onSaveApiKey={() => setApiKeySaved(true)}
              target={settingsTarget}
              workspaceName={workspaceName}
            />
          ) : null}
          {route === AppRoute.Dashboard ? (
            <Dashboard
              githubConnected={githubConnected}
              onConnectGitHub={() => setGithubConnected(true)}
              onHideDemoData={disableDemo}
              onShowDemoData={enableDemo}
              showDemoData={showDemoData}
              workspaceName={workspaceName}
            />
          ) : null}
          {route === AppRoute.Sessions ? (
            <ActivityView
              description="Latest agent runs analyzed from your workspace."
              emptyDescription="Agent sessions from your workspace will show up here."
              emptyTitle="No sessions yet"
              onHideDemoData={disableDemo}
              onShowDemoData={enableDemo}
              rows={recentSessions}
              showDemoData={showDemoData}
              title="Sessions"
              valueLabel="Efficiency"
            />
          ) : null}
          {route === AppRoute.Branches ? (
            <ActivityView
              description="Branches matched to the sessions that produced them."
              emptyDescription="Branches matched to your sessions will show up here."
              emptyTitle="No branches yet"
              onHideDemoData={disableDemo}
              onShowDemoData={enableDemo}
              rows={recentBranches}
              showDemoData={showDemoData}
              title="Branches"
              valueLabel="Sessions"
            />
          ) : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};

const AppHeader = ({ route }: { route: AppRouteType }) => (
  <header className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
    <SidebarTrigger className="text-muted-foreground" />
    <span className="text-sm">{getRouteTitle(route)}</span>
  </header>
);

const ActivityView = ({
  description,
  rows,
  title,
  valueLabel,
  showDemoData,
  emptyTitle,
  emptyDescription,
  onShowDemoData,
  onHideDemoData,
}: {
  description: string;
  rows: readonly ActivityRow[];
  title: string;
  valueLabel?: string;
  showDemoData: boolean;
  emptyTitle: string;
  emptyDescription: string;
  onShowDemoData: () => void;
  onHideDemoData: () => void;
}) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 md:p-10">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      {showDemoData ? (
        <Button onClick={onHideDemoData} size="sm" variant="outline">
          Clear demo data
        </Button>
      ) : null}
    </div>
    {showDemoData ? (
      <ActivityCard rows={rows} valueLabel={valueLabel} />
    ) : (
      <Card>
        <EmptyState
          action={
            <Button onClick={onShowDemoData} variant="outline">
              Preview with demo data
            </Button>
          }
          description={emptyDescription}
          icon={CableIcon}
          title={emptyTitle}
        />
      </Card>
    )}
  </div>
);

const getRouteTitle = (route: AppRouteType) => {
  if (route === AppRoute.Dashboard) {
    return "Dashboard";
  }
  if (route === AppRoute.Sessions) {
    return "Sessions";
  }
  if (route === AppRoute.Branches) {
    return "Branches";
  }
  if (route === AppRoute.Settings) {
    return "Settings";
  }
  return "My Tasks";
};
