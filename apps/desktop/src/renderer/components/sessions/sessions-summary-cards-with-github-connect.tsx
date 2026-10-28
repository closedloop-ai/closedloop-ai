import { SessionsSummaryCards } from "@repo/app/agents/components/sessions/sessions-summary-cards";
import {
  resolveGitHubConnectAction,
  resolveGitHubGateConnected,
} from "@repo/app/github/lib/github-connect-action";
import type { ComponentProps } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { isDesktopAuthSettled } from "../../shared-agent-sessions/desktop-auth-signed-out";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { useDesktopGitHubIntegrationStatus } from "../../shared-branches/desktop-github-integration-status";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../branches/use-desktop-github-connect";

/**
 * ISS-7869: the Sessions summary strip with the desktop's GitHub connect wiring
 * attached, so its delivery cards can offer the same ask Branches, Insights and
 * the Dashboard already do.
 *
 * A separate component rather than two more hooks in `SessionsView`, which is
 * already one of the largest modules in the renderer. The seam also names the
 * mount requirement it adds: `useDesktopGitHubConnect` reaches for the ambient
 * `QueryClient`, which production always supplies and several `SessionsView`
 * test sites did not until ISS-7869 gave them one.
 */
export function SessionsSummaryCardsWithGitHubConnect(
  props: ComponentProps<typeof SessionsSummaryCards>
) {
  const { connectState, githubConnect, githubConnected } =
    useDesktopSessionsGitHubConnectGate(props.authenticated ?? true);
  return (
    <>
      <DesktopSessionsConnectOutcome state={connectState} />
      <SessionsSummaryCards
        {...props}
        githubConnect={githubConnect}
        githubConnected={githubConnected}
      />
    </>
  );
}

/**
 * ISS-9107: the gate itself, so the v2 branch can put the same ask on the strip
 * the surface owns. Both branches read this ONE hook — a second derivation is
 * how the two stacks come to disagree about whether to ask.
 */
export function useDesktopSessionsGitHubConnectGate(authenticated: boolean): {
  connectState: DesktopGitHubConnectState;
  githubConnect: ReturnType<typeof useDesktopGitHubConnect>["connectTarget"];
  githubConnected: boolean | undefined;
} {
  // ONE read answers both halves: whether to ask, and what the ask says. The
  // action is resolved here and handed down, which also keeps
  // `useDesktopGitHubConnect` from fetching a status of its own through
  // `useApiClient` — an API-client hook this view's mount sites do not supply,
  // and a second source that would disagree with this one while unresolved.
  const status = useDesktopGitHubIntegrationStatus();
  // ISS-7866 review (whitlockk): `authenticated` alone cannot tell a signed-in user
  // from one mid-handoff — both read `true` through the transient-aware
  // predicate — so a stale `connected: false` would put a live second CTA on top
  // of a connect already running. The settled check is what withholds it.
  const { state: authState } = useDesktopAuth();
  const authSettled = isDesktopAuthSettled(authState.status);
  // Desktop passes a HANDLER target (the connect IPC), never an href: an in-app
  // link here is the FEA-3280 dead click.
  const { connectState, connectTarget } = useDesktopGitHubConnect({
    connectAction: resolveGitHubConnectAction({ authenticated, status }),
    returnTo: "/sessions",
  });
  return {
    connectState,
    githubConnect: connectTarget,
    githubConnected: resolveGitHubGateConnected({
      authSettled,
      authenticated,
      status,
    }),
  };
}

/**
 * ISS-7866: the outcome of the handoff, on the same surface that offered it —
 * the shape Branches and the Insights provider already use. This strip's
 * previous ask was a sign-in control that rendered its own failure inline;
 * swapping it for the connect ask without this would have made a failed connect
 * silent, which is the FEA-3280 dead click in a new place. Renders nothing until
 * the user acts (Idle -> null).
 */
export function DesktopSessionsConnectOutcome({
  state,
}: {
  state: DesktopGitHubConnectState;
}) {
  if (state === DesktopGitHubConnectState.Idle) {
    return null;
  }
  return (
    <div className="px-4 pb-3">
      <DesktopConnectStatus state={state} variant="list" />
    </div>
  );
}
