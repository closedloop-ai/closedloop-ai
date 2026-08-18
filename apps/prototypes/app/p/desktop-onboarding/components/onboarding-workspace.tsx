"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Button } from "@repo/design-system/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import {
  CompassIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  UserPlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuthTrigger, getSyncStatusCopy, type SyncTierId } from "../mock";
import { AuthModal } from "./auth-modal";
import { ConnectGitHub } from "./connect-github";
import { GuestBadge } from "./guest-badge";
import { LocalDashboard } from "./local-dashboard";
import { OnboardingSidebar } from "./onboarding-sidebar";
import { OnboardingTour } from "./onboarding-tour";
import { SyncConsent } from "./sync-consent";

const ANALYZE_MS = 2200;
const TOUR_ARM_MS = 500;

type AuthModalState = { trigger: AuthTrigger; mode: "create" | "signin" };

export const OnboardingWorkspace = () => {
  const [account, setAccount] = useState(false);
  const [syncTier, setSyncTier] = useState<SyncTierId | null>(null);
  const [authModal, setAuthModal] = useState<AuthModalState | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(true);
  const [tourActive, setTourActive] = useState(false);
  const tourArmed = useRef(false);
  const analyzeTimer = useRef<number | null>(null);
  const tourTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (analyzeTimer.current !== null) {
      window.clearTimeout(analyzeTimer.current);
      analyzeTimer.current = null;
    }
    if (tourTimer.current !== null) {
      window.clearTimeout(tourTimer.current);
      tourTimer.current = null;
    }
  }, []);

  // Clear any outstanding timers before (re)scheduling so a restart never lets a
  // stale analyze/tour timeout fire during the newer replay.
  const scheduleAnalyze = useCallback(() => {
    clearTimers();
    setAnalyzing(true);
    tourArmed.current = false;
    analyzeTimer.current = window.setTimeout(() => {
      setAnalyzing(false);
      tourArmed.current = true;
      tourTimer.current = window.setTimeout(
        () => setTourActive(true),
        TOUR_ARM_MS
      );
    }, ANALYZE_MS);
  }, [clearTimers]);

  useEffect(() => {
    scheduleAnalyze();
    return clearTimers;
  }, [scheduleAnalyze, clearTimers]);

  const openAuth = (
    trigger: AuthTrigger,
    mode: "create" | "signin" = "create"
  ) => {
    setAuthModal({ trigger, mode });
  };

  const handleAuthSuccess = (method: "github" | "google" | "email") => {
    // Identity is minted (Clerk = SoT). A GitHub sign-up is one-shot — it
    // already granted the scoped token — so it goes straight to sync consent.
    // Google / email sign-ups must complete the required GitHub connection.
    setAccount(true);
    setAuthModal(null);
    if (method === "github") {
      setSyncOpen(true);
    } else {
      setConnectOpen(true);
    }
  };

  const handleGithubConnected = () => {
    setConnectOpen(false);
    setSyncOpen(true);
  };

  const finishSync = (tier: SyncTierId) => {
    setSyncTier(tier);
    setSyncOpen(false);
  };

  const restart = () => {
    setAccount(false);
    setSyncTier(null);
    setAuthModal(null);
    setSyncOpen(false);
    setConnectOpen(false);
    setTourActive(false);
    scheduleAnalyze();
  };

  return (
    <SidebarProvider className="h-svh">
      <OnboardingSidebar onInviteTeam={() => openAuth("invite")} />
      <SidebarInset className="relative">
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ml-1 text-muted-foreground" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>Local workspace</BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>Dashboard</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>

          <div className="flex items-center gap-2">
            {analyzing ? (
              <span className="hidden items-center gap-1.5 font-mono text-muted-foreground text-xs md:inline-flex">
                <span className="size-1.5 animate-pulse rounded-full bg-info" />
                Analyzing locally · 2,815 / 4,695
              </span>
            ) : (
              <span className="hidden items-center gap-1.5 text-muted-foreground text-xs md:inline-flex">
                <ShieldCheckIcon className="size-3.5 text-success" />
                {getSyncStatusCopy(syncTier).headerStatus}
              </span>
            )}
            {analyzing ? null : (
              <Button
                onClick={() => setTourActive(true)}
                size="sm"
                variant="ghost"
              >
                <CompassIcon />
                Tour
              </Button>
            )}
            <GuestBadge account={account} />
            {/* Synced badge only once a tier is chosen; Create-account only for
                guests; mid-setup (identity minted, syncing not done) shows
                neither since the connect / sync overlay is up. */}
            {syncTier ? (
              <Badge className="gap-1.5 border-success/25 bg-success/12 text-success">
                <span className="size-1.5 rounded-full bg-current" />
                Account synced · {syncTier}
              </Badge>
            ) : null}
            {account ? null : (
              <Button onClick={() => openAuth("stack")} size="sm">
                <UserPlusIcon />
                Create account
              </Button>
            )}
            <Button onClick={restart} size="icon-sm" variant="ghost">
              <RotateCcwIcon />
              <span className="sr-only">Restart demo</span>
            </Button>
          </div>
        </header>

        {analyzing ? (
          <div className="h-0.5 w-full overflow-hidden bg-transparent">
            <div className="h-full w-2/3 animate-pulse bg-info" />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <LocalDashboard
            account={account}
            onCreateAccount={() => openAuth("stack")}
            syncTier={syncTier}
            teamHighlight={!account}
          />
        </div>

        {/* Required GitHub connection for Google/email sign-ups (blocking),
            then the sync-consent cover. */}
        <ConnectGitHub onConnected={handleGithubConnected} open={connectOpen} />
        <SyncConsent onDone={finishSync} open={syncOpen} />
      </SidebarInset>

      <AuthModal
        mode={authModal?.mode ?? "create"}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
        open={authModal !== null}
        trigger={authModal?.trigger ?? "stack"}
      />

      <OnboardingTour
        active={tourActive}
        onClose={() => setTourActive(false)}
      />
    </SidebarProvider>
  );
};
