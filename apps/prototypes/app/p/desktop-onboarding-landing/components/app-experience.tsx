"use client";

import {
  SidebarInset,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { branchesTotal, sessionsTotal } from "../app-mock";
import { createInitialFlowState, flowReducer } from "../flow-reducer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { BranchesView } from "./branches-view";
import { DashboardView } from "./dashboard-view";
import { InviteTeamDialog } from "./invite-team-dialog";
import { OnboardingTour } from "./onboarding-tour";
import { SessionsView } from "./sessions-view";
import { SignUpOverlay } from "./signup-overlay";

const PROGRESS_TICK_MS = 320;
const TOUR_ARM_MS = 700;

export const AppExperience = ({
  initialSignedUp = false,
  emptySessions = false,
  onSignIn,
}: {
  initialSignedUp?: boolean;
  /** Models a fresh machine with no agent history (`?empty` on the page URL). */
  emptySessions?: boolean;
  /** Routes the returning-user path into the shared system-browser auth flow. */
  onSignIn: () => void;
}) => {
  const [state, dispatch] = useReducer(
    flowReducer,
    initialSignedUp,
    createInitialFlowState
  );
  const tourArmed = useRef(false);

  // The totals every visible count derives from. An empty first run finds
  // nothing, so every surface reads zero rather than the seeded totals.
  const totalSessions = emptySessions ? 0 : sessionsTotal;
  const totalBranches = emptySessions ? 0 : branchesTotal;

  // Local parsing simulation: progress climbs to 100 while the dashboard fills.
  useEffect(() => {
    if (state.progress >= 100) {
      return;
    }
    const id = window.setInterval(
      () => dispatch({ type: "tick" }),
      PROGRESS_TICK_MS
    );
    return () => window.clearInterval(id);
  }, [state.progress]);

  // Once parsing settles, auto-open the tour a beat later (once). A scan that
  // found nothing never opens the tour (nothing to walk through), and a sign-up
  // prompt already open holds the tour back so completing that prompt resumes
  // on its intent rather than being interrupted (wongk PR #4368 review); once
  // the prompt closes the effect re-runs and arms it.
  useEffect(() => {
    if (
      state.progress >= 100 &&
      !tourArmed.current &&
      !state.signedUp &&
      state.overlay === null &&
      totalSessions > 0
    ) {
      tourArmed.current = true;
      const timer = window.setTimeout(
        () => dispatch({ type: "open-tour" }),
        TOUR_ARM_MS
      );
      return () => window.clearTimeout(timer);
    }
  }, [state.progress, state.signedUp, state.overlay, totalSessions]);

  const handleSignedUp = useCallback(() => dispatch({ type: "signed-up" }), []);

  const parsing = state.progress < 100;
  // The one progress snapshot every visible total derives from (r3706995125):
  // the scan pill, the sidebar badges, and the Sessions stat all count up
  // together instead of the chrome exposing the final totals mid-parse.
  const parsedCount = Math.round((state.progress / 100) * totalSessions);
  const parsedBranches = Math.round((state.progress / 100) * totalBranches);

  return (
    <SidebarProvider className="h-svh">
      <AppSidebar
        activeRoute={state.route}
        counts={{ sessions: parsedCount, branches: parsedBranches }}
        onInviteTeam={() =>
          state.signedUp
            ? dispatch({ type: "open-invite" })
            : dispatch({ type: "open-signup", context: "invite" })
        }
        onNavigate={(route) => dispatch({ type: "navigate", route })}
      />
      <SidebarInset className="relative flex min-w-0 flex-col">
        <AppHeader route={state.route} signedUp={state.signedUp} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {state.route === "dashboard" ? (
            <DashboardView
              empty={emptySessions}
              onScopeChange={(value) => dispatch({ type: "set-scope", value })}
              onSignUp={() =>
                dispatch({ type: "open-signup", context: "header" })
              }
              onTour={() => dispatch({ type: "open-tour" })}
              parsedCount={parsedCount}
              parsing={parsing}
              progress={state.progress}
              scope={state.scope}
              signedUp={state.signedUp}
            />
          ) : null}
          {state.route === "sessions" ? (
            <SessionsView empty={emptySessions} />
          ) : null}
          {state.route === "branches" ? (
            <BranchesView empty={emptySessions} />
          ) : null}
        </main>
      </SidebarInset>

      <OnboardingTour
        active={state.tourActive}
        onClose={(reason) => dispatch({ type: "close-tour", reason })}
        signedUp={state.signedUp}
      />
      <SignUpOverlay
        context={state.overlay}
        onClose={() => dispatch({ type: "close-signup" })}
        onComplete={handleSignedUp}
        onSignIn={onSignIn}
      />
      <InviteTeamDialog
        onClose={() => dispatch({ type: "close-invite" })}
        open={state.inviteOpen}
      />
    </SidebarProvider>
  );
};
