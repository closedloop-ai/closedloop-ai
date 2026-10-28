"use client";

import { SessionsSummaryCards } from "@repo/app/agents/components/sessions/sessions-summary-cards";
import { useGitHubConnectHrefTarget } from "@repo/app/github/hooks/use-github-connect-action";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { resolveGitHubGateConnected } from "@repo/app/github/lib/github-connect-action";
import type { ComponentProps } from "react";
import { useGitHubAuthorizeHref } from "@/hooks/use-github-authorize-href";
import { useOrgSlug } from "@/hooks/use-org-slug";

/**
 * ISS-7869: the Sessions summary strip with the web GitHub connect wiring
 * attached, so its delivery cards can offer the same ask Branches, Insights and
 * the Dashboard already do.
 *
 * A separate component for the reason its desktop twin is: it keeps the page's
 * own module smaller, and it names the mount requirement it adds — the status
 * read calls `useApiClient()`, which throws without an `<ApiAdapterProvider>`
 * ancestor. Production always has one; several page test sites did not until
 * ISS-7869 gave them one.
 */
export function SessionsSummaryCardsWithGitHubConnect(
  props: ComponentProps<typeof SessionsSummaryCards>
) {
  const githubGate = useSessionsGitHubConnectGate();
  return <SessionsSummaryCards {...props} {...githubGate} />;
}

/**
 * The gate above, as a hook, because the v2 Sessions surface renders
 * `SessionsSummaryCards` ITSELF — the strip is inside `SessionsListSurfaceV2`,
 * not composed by the page — so that branch cannot swap in the wrapper
 * component. It reaches the same two props through the surface's `summaryCards`
 * passthrough instead. One gate, so the two listing branches cannot answer
 * "is GitHub connected?" differently (ISS-7866).
 */
export function useSessionsGitHubConnectGate(): Pick<
  ComponentProps<typeof SessionsSummaryCards>,
  "githubConnect" | "githubConnected"
> {
  // Read here rather than taken as a prop, so this component and the plain
  // `SessionsSummaryCards` share ONE props type and the page can pick between
  // them without a prop only one of them accepts.
  const orgSlug = useOrgSlug();
  // Read unconditionally within this component: the gate and the render are the
  // same instant, so gating the READ would paint the first-time verb and swap
  // it to `Reconnect` a roundtrip later — the ISS-5958 D2 collapse arriving late
  // (Kerensa, 2026-08-21). Same posture the Branches page takes.
  const status = useGitHubIntegrationStatus();
  // ISS-7869 added `sessions` to `GitHubConnectReturnSegment`, so this target is
  // honored on the way back rather than degrading to the default surface.
  const href = useGitHubAuthorizeHref({ returnTo: `/${orgSlug}/sessions` });
  // A web `(authenticated)` route always has a session behind it, so this is
  // never a sign-up — only whether the user's OWN grant is what broke changes
  // the verb.
  const githubConnect = useGitHubConnectHrefTarget({
    authenticated: true,
    href,
  });
  return {
    githubConnect,
    // Through the shared gate resolver so web and desktop cannot answer this
    // differently (ISS-7866). `authenticated` is a literal here — a web
    // `(authenticated)` route always has a session — so this reduces to the
    // status read: `undefined` is UNKNOWN, never disconnected, because EITHER
    // an active personal grant or an org App installation connects and a read
    // that has not landed says nothing about which.
    githubConnected: resolveGitHubGateConnected({
      authenticated: true,
      status: status.data,
    }),
  };
}
