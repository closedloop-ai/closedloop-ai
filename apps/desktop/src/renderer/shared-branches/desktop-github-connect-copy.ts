import { DesktopGitHubConnectState } from "../components/branches/use-desktop-github-connect";
import type { DesktopStatusBannerTone } from "./desktop-status-banner";

/**
 * Which desktop surface is reporting a connect-GitHub handoff. It selects the
 * surface-specific half of the message only — what the state MEANS is spelled
 * once, in {@link STATE_MESSAGE}:
 * - `list` — an inline card above a list surface that HAS its content on screen.
 *   Three pages render it: Sessions (both the v1 strip and the v2 view),
 *   Insights, and the Dashboard, which mounts the same `DesktopInsightsProvider`
 *   banner. Its continuation therefore names NO page. It used to say "Branches
 *   refresh …", which was true on none of the three and told every reader to
 *   watch a page they were not on (ISS-11326, found by whitlockk on #7990).
 * - `stalledList` — the Branches stalled-load slot that ISS-11274 retained. Same chrome as `list` and a different thing to
 *   say: it renders only inside `renderListLoadingBody` at `isLoading &&
 *   !hasData` (`packages/app/shared/components/list-loading-body.tsx`), under a
 *   spinner reading "Loading branches…", so it is the one list surface that
 *   cannot tell the reader their data is in front of them.
 * - `panel` — a settings/onboarding panel, which has no list data to fall
 *   back to and so states the remedy instead.
 */
export const DesktopGitHubConnectSurface = {
  List: "list",
  StalledList: "stalledList",
  Panel: "panel",
} as const;
export type DesktopGitHubConnectSurface =
  (typeof DesktopGitHubConnectSurface)[keyof typeof DesktopGitHubConnectSurface];

export type DesktopGitHubConnectMessage = {
  tone: DesktopStatusBannerTone;
  message: string;
};

/**
 * The tone and copy every desktop surface uses for one connect-GitHub terminal
 * state (ISS-5958). `Idle` and `Pending` are absent: they render nothing.
 *
 * Copy is assembled from one sentence per STATE plus at most one
 * surface-specific continuation, so a surface can say what happens next on IT
 * without giving the state a second spelling. Before this map the same three
 * states were spelled four different ways across the branch banners, the
 * Settings account tab, and the onboarding flow.
 */
const STATE_MESSAGE: Partial<Record<DesktopGitHubConnectState, string>> = {
  [DesktopGitHubConnectState.Opened]:
    "Continue in the browser to connect GitHub.",
  // ISS-5958 M4: signing in is no longer a hidden pre-step of "connect" — a
  // signed-out CTA declares itself as sign-up, so this state reports that
  // declared action failing, not a prerequisite the user never saw.
  [DesktopGitHubConnectState.SignInRequired]:
    "GitHub sign-up was not completed.",
  [DesktopGitHubConnectState.Failed]: "GitHub connect could not be opened.",
};

const STATE_TONE: Partial<
  Record<DesktopGitHubConnectState, DesktopStatusBannerTone>
> = {
  [DesktopGitHubConnectState.Opened]: "success",
  [DesktopGitHubConnectState.SignInRequired]: "warning",
  [DesktopGitHubConnectState.Failed]: "error",
};

/**
 * Where a reader watches for the handoff to land. One literal for both surfaces
 * because it is one sentence: "this page" resolves to whichever page the reader
 * is on, which is the only referent that stays true on every page either surface
 * renders (ISS-11326). Spelling it twice is how the `list` continuation came to
 * name one page while the `panel` one beside it already said this correctly.
 */
const CONNECTION_PENDING_CONTINUATION =
  "This page updates when the connection is available.";

/**
 * The remedy, for every state and surface whose honest next line is another go
 * rather than a reassurance. One literal because it is one sentence: the CTA is
 * on screen in all three surfaces, and a second spelling of "retry" is the drift
 * this map exists to stop.
 */
const RETRY_CONTINUATION = "Try again.";

const SURFACE_CONTINUATION: Record<
  DesktopGitHubConnectSurface,
  Partial<Record<DesktopGitHubConnectState, string>>
> = {
  [DesktopGitHubConnectSurface.List]: {
    [DesktopGitHubConnectState.Opened]: CONNECTION_PENDING_CONTINUATION,
    // Not "Local BRANCH data": each of these three pages keeps a DIFFERENT
    // locally-captured population when the GitHub read is gone — Sessions its
    // session/token/cost cards and table, Insights and the Dashboard their
    // utilization and agent tiles — and all three have that content on screen
    // beneath this banner, so the noun true for all of them is the bare one
    // (ISS-11326). The stalled Branches slot cannot say this at all; see below.
    [DesktopGitHubConnectState.Failed]: "Local data remains available.",
    // A next step, not a consolation: the connect FAILING leaves local data as
    // the thing worth saying, but an unfinished sign-up just needs another go,
    // and the CTA is right there.
    [DesktopGitHubConnectState.SignInRequired]: RETRY_CONTINUATION,
  },
  [DesktopGitHubConnectSurface.StalledList]: {
    [DesktopGitHubConnectState.Opened]: CONNECTION_PENDING_CONTINUATION,
    // The remedy, NOT `list`'s retained-data line. This slot renders only while
    // the blocking read has produced nothing, under a spinner that says the
    // branches are still loading, so "Local data remains available." would
    // reassure the reader about content that is not there — the copy half of a
    // UI lying about its own state. Nothing is withheld by saying this instead:
    // the three surfaces that CAN back that claim still make it, and the retry
    // control is in this same slot (ISS-11326).
    [DesktopGitHubConnectState.Failed]: RETRY_CONTINUATION,
    [DesktopGitHubConnectState.SignInRequired]: RETRY_CONTINUATION,
  },
  [DesktopGitHubConnectSurface.Panel]: {
    [DesktopGitHubConnectState.Opened]: CONNECTION_PENDING_CONTINUATION,
    [DesktopGitHubConnectState.Failed]: RETRY_CONTINUATION,
    [DesktopGitHubConnectState.SignInRequired]: RETRY_CONTINUATION,
  },
};

/**
 * The tone + copy for one connect-GitHub state on one surface, or `null` when
 * the state has nothing to say (`Idle`, `Pending`, and any state added later).
 */
export function desktopGitHubConnectMessage(
  state: DesktopGitHubConnectState,
  surface: DesktopGitHubConnectSurface
): DesktopGitHubConnectMessage | null {
  const message = STATE_MESSAGE[state];
  const tone = STATE_TONE[state];
  if (!(message && tone)) {
    return null;
  }
  const continuation = SURFACE_CONTINUATION[surface][state];
  return {
    tone,
    message: continuation ? `${message} ${continuation}` : message,
  };
}

/**
 * The copy for a connect-GitHub state that went WRONG, or `null` for a state
 * that did not (`Opened`, and the non-terminal states). For surfaces that only
 * render a failure line and leave the success handoff to the flow itself.
 */
export function desktopGitHubConnectFailureMessage(
  state: DesktopGitHubConnectState,
  surface: DesktopGitHubConnectSurface
): string | null {
  const content = desktopGitHubConnectMessage(state, surface);
  if (!content || content.tone === "success") {
    return null;
  }
  return content.message;
}
