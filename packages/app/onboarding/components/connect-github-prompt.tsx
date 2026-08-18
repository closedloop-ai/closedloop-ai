"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Github, Loader2, ShieldCheck } from "lucide-react";

const DEFAULT_GRANTS = [
  "Read pull requests, commits and files you can already reach",
  "Read your organizations and teams",
  "Attribute PR comments you post from Closedloop to you",
] as const;

type ConnectGitHubPromptProps = {
  /** Runs the real GitHub authorize flow (host-wired). */
  onConnect: () => void;
  /** Controlled in-flight state (host-owned): drives the spinner + disables. */
  connecting?: boolean;
  /** What authorizing grants Closedloop, acting as this user. */
  grants?: readonly string[];
  /**
   * Applied to this step's heading so a host that owns the surrounding surface
   * can name it from what is actually on screen (ISS-5112: the desktop account
   * dialog's `aria-labelledby`). Omitted everywhere else.
   */
  headingId?: string;
};

/**
 * The second step of the unified auth flow (PRD-532 §5.2): a value-explaining,
 * required "grant GitHub access" prompt.
 *
 * WHAT THIS ACTUALLY STARTS, because the copy has now been wrong twice in
 * opposite directions and the flow is the only thing that settles it. Both
 * production consumers (`desktop-account-tab.tsx`, and `desktop-onboarding-flow.tsx`
 * via `AccountSetupFlow`) wire `onConnect` to `useDesktopGitHubConnect` WITHOUT
 * the optional `resolveInstall` pre-flight, so `openGitHubConnect` is called
 * with no `install` flag. `apps/app/app/api/integrations/github/route.ts` then
 * computes `useInstallFlow = forceInstall ? !!appSlug : !clientId && !!appSlug`
 * — and `GITHUB_APP_CLIENT_ID` is required (`packages/github/keys.ts`), so
 * `clientId` is truthy and `useInstallFlow` is FALSE. The user is sent to
 * `https://github.com/login/oauth/authorize`: a per-user authorization of the
 * GitHub App.
 *
 * So this screen must NOT promise an installation. It needs no org admin, and
 * it presents no repository picker — the two things the previous revision told
 * the user to expect. What the resulting token can actually reach is decided by
 * where the App is already installed, not by anything chosen here.
 *
 * The revision before that had the opposite error: it sold the grant as "a
 * security upgrade over a broad `repo` OAuth scope". That inverts the credential
 * model this repo deploys (PLN-1525), where the broad OAuth scope carried by
 * Clerk's GitHub sign-in is the PRIMARY credential. Neither claim belongs here.
 *
 * If this component is ever pointed at the real App-install flow, the copy has
 * to change WITH it — and PRD-562's "ask your GitHub org admin" degradation
 * becomes mandatory at that point, because an install genuinely can strand a
 * non-admin. It cannot today.
 *
 * Surface-agnostic: the host wires `onConnect` to the platform connect route and
 * owns the in-flight state. Connect once — the resulting `GitHubUserConnection`
 * is org+user-scoped and live across desktop, web, and multiplayer, so there is
 * no separate per-surface GitHub integration to repeat.
 */
export function ConnectGitHubPrompt({
  onConnect,
  connecting = false,
  grants = DEFAULT_GRANTS,
  headingId,
}: ConnectGitHubPromptProps) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      {/* Plain mark, no bordered chip: two stops earlier in this same flow the
          transition panel renders a bare size-6 GitHub mark, and an icon boxed
          in its own container is the template look we keep pulling out of
          screens. One treatment for one mark, across the whole flow. */}
      <Github className="size-6" />
      <p className="mt-4 font-semibold text-primary text-xs uppercase tracking-wider">
        One more step · Required
      </p>
      <h1
        className="mt-1.5 font-semibold text-2xl tracking-tight"
        id={headingId}
      >
        Connect GitHub to finish setup
      </h1>
      <p className="mx-auto mt-2 max-w-sm text-pretty text-muted-foreground text-sm leading-relaxed">
        Authorize Closedloop on GitHub so we read your PR and repo activity
        through the GitHub API, never by driving your local gh or git under your
        personal credentials. Closedloop acts as you, and only reaches what you
        can already reach.
      </p>

      <div className="mt-5 w-full rounded-xl border border-border bg-card p-4 text-left">
        <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          You'll grant access to
        </p>
        <ul className="mt-2 space-y-1.5">
          {grants.map((grant) => (
            <li className="flex items-center gap-2 text-xs" key={grant}>
              <ShieldCheck className="size-3.5 shrink-0 text-success" />
              {grant}
            </li>
          ))}
        </ul>
      </div>

      <Button
        aria-busy={connecting}
        className="mt-5 w-full"
        disabled={connecting}
        onClick={onConnect}
        size="lg"
        type="button"
      >
        {connecting ? <Loader2 className="animate-spin" /> : <Github />}
        Continue with GitHub
      </Button>
      <p className="mt-3 text-muted-foreground text-xs">
        A per-user grant, no admin rights needed. Revocable anytime in GitHub.
      </p>
    </div>
  );
}
