"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Card } from "@repo/design-system/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { CableIcon, CheckIcon } from "lucide-react";
import { useState } from "react";
import {
  type ActivityRow,
  AppRoute,
  type AppRoute as AppRouteType,
  activityTotals,
  recentBranches,
  recentSessions,
} from "../mock";
import { AccountDialog } from "./account-dialog";
import { ActivityCard } from "./activity-card";
import { Dashboard } from "./dashboard";
import { QuickTour } from "./quick-tour";
import { WorkspaceSidebar } from "./workspace-sidebar";

type WebAppProps = {
  initialDesktopConnected: boolean;
  initialGithubConnected: boolean;
  initialTourActive: boolean;
  signedIn: boolean;
  onSignUp: () => void;
  workspaceName: string;
};

export const WebApp = ({
  initialDesktopConnected,
  initialGithubConnected,
  initialTourActive,
  signedIn,
  onSignUp,
  workspaceName,
}: WebAppProps) => {
  const [desktopConnected, setDesktopConnected] = useState(
    initialDesktopConnected
  );
  const [githubConnected, setGithubConnected] = useState(
    initialGithubConnected
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [route, setRoute] = useState<AppRouteType>(AppRoute.Dashboard);
  const [tourActive, setTourActive] = useState(initialTourActive);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  const connectGitHub = () => {
    setGithubConnected(true);
    setRoute(AppRoute.Dashboard);
  };

  const installDesktop = () => {
    setDesktopConnected(true);
    setRoute(AppRoute.Dashboard);
  };

  return (
    <SidebarProvider className="h-svh">
      <WorkspaceSidebar
        activeRoute={route}
        branchCount={desktopConnected ? activityTotals.branches : undefined}
        inviteSent={inviteSent}
        onInvite={() => setInviteOpen(true)}
        onNavigate={setRoute}
        onSignUp={onSignUp}
        sessionCount={desktopConnected ? activityTotals.sessions : undefined}
        signedIn={signedIn}
        workspaceName={workspaceName}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <AppHeader route={route} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {route === AppRoute.Dashboard ? (
            <Dashboard
              desktopConnected={desktopConnected}
              githubConnected={githubConnected}
              onConnectGitHub={connectGitHub}
              onInstallDesktop={installDesktop}
              onSignUp={onSignUp}
              onTour={() => setTourActive(true)}
              signedIn={signedIn}
              workspaceName={workspaceName}
            />
          ) : null}
          {route === AppRoute.Sessions ? (
            <ActivityView
              connectLabel="Install Closedloop Desktop"
              description="Latest agent runs analyzed from this Mac."
              emptyDescription="Install Closedloop Desktop to collect AI coding sessions and spend from this machine."
              emptyTitle="No sessions yet"
              onConnect={installDesktop}
              rows={desktopConnected ? recentSessions : []}
              title="Sessions"
              valueLabel="Efficiency"
            />
          ) : null}
          {route === AppRoute.Branches ? (
            <ActivityView
              connectLabel="Install Closedloop Desktop"
              description="Local branches matched to the sessions that produced them."
              emptyDescription="Install Closedloop Desktop to read branches from local repository history."
              emptyTitle="No branches yet"
              onConnect={installDesktop}
              rows={desktopConnected ? recentBranches : []}
              title="Branches"
              valueLabel="Sessions"
            />
          ) : null}
        </div>
      </SidebarInset>
      <QuickTour
        active={tourActive}
        onComplete={() => {
          setTourActive(false);
          setAccountDialogOpen(true);
        }}
        onSkip={() => setTourActive(false)}
      />
      <AccountDialog
        onAuth={() => {
          setAccountDialogOpen(false);
          onSignUp();
        }}
        onOpenChange={setAccountDialogOpen}
        open={accountDialogOpen}
      />
      <InviteDialog
        onOpenChange={(open) => setInviteOpen(open)}
        onSent={() => setInviteSent(true)}
        open={inviteOpen}
        workspaceName={workspaceName}
      />
    </SidebarProvider>
  );
};

const AppHeader = ({ route }: { route: AppRouteType }) => (
  <header className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
    <SidebarTrigger className="text-muted-foreground" />
    <span className="text-sm">{getRouteTitle(route)}</span>
  </header>
);

const InviteDialog = ({
  onOpenChange,
  onSent,
  open,
  workspaceName,
}: {
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
  open: boolean;
  workspaceName: string;
}) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setEmail("");
      setSent(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            Add someone to {workspaceName} so you can compare outcomes together.
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckIcon className="size-4 text-success" />
            Invitation ready for {email}.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSent(true);
              onSent();
            }}
          >
            <Input
              aria-label="Teammate email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@company.com"
              required
              type="email"
              value={email}
            />
            <DialogFooter className="mt-4">
              <Button type="submit">Send invite</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

const ActivityView = ({
  connectLabel,
  description,
  emptyDescription,
  emptyTitle,
  onConnect,
  rows,
  title,
  valueLabel,
}: {
  connectLabel: string;
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  onConnect: () => void;
  rows: readonly ActivityRow[];
  title: string;
  valueLabel?: string;
}) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 md:p-10">
    <div>
      <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
      <p className="mt-1 text-muted-foreground text-sm">{description}</p>
    </div>
    {rows.length === 0 ? (
      <Card>
        <EmptyState
          action={<Button onClick={onConnect}>{connectLabel}</Button>}
          description={emptyDescription}
          icon={CableIcon}
          title={emptyTitle}
        />
      </Card>
    ) : (
      <ActivityCard rows={rows} valueLabel={valueLabel} />
    )}
  </div>
);

const getRouteTitle = (route: AppRouteType) => {
  if (route === AppRoute.Sessions) {
    return "Sessions";
  }
  if (route === AppRoute.Branches) {
    return "Branches";
  }
  return "Dashboard";
};
