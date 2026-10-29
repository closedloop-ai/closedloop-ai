"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { Loader2, ShieldCheck } from "lucide-react";
import {
  GitHubConnectAction,
  type GitHubConnectPromptAction,
} from "../../github/lib/github-connect-action";
import { GITHUB_CONNECT_PROMPT_COPY } from "../../github/lib/github-connect-copy";
import { GitHubLogo } from "../../shared/feature-flags/github-logo";

const DEFAULT_GRANTS = [
  "Read pull requests, commits and files you can already reach",
  "Read your organizations and teams",
  "Attribute PR comments you post from Closedloop to you",
] as const;

type ConnectGitHubPromptProps = {
  /**
   * Which connect this prompt is performing (ISS-5958 D2). Defaults to a
   * first-time connect; a host that knows the user's grant expired or was
   * revoked passes `Reconnect`, which is worded distinctly so the two controls
   * cannot collapse into one.
   */
  action?: GitHubConnectPromptAction;
  /** Runs the real GitHub authorize flow (host-wired). */
  onConnect: () => void;
  /** Controlled in-flight state (host-owned): drives the spinner + disables. */
  connecting?: boolean;
  /**
   * Why the last connect handoff could not be opened, or `null`. Host-owned and
   * host-worded — this component classifies nothing.
   *
   * Set, it renders below the CTA in the destructive tone with the CTA standing
   * as the retry, the same contract `GatedMetricIndicator` states for its own
   * `error`. Without it a rejected handoff leaves this screen byte-identical to
   * before the click: the spinner goes on, comes back off, and nothing says the
   * flow never opened (ISS-10990). The Settings panel already rendered that
   * failure beside this prompt; this is the slot that lets every host do it.
   */
  error?: string | null;
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
 * opposite directions and the flow is the only thing that settles it. Its one
 * production consumer (`guided-onboarding-github-step.tsx`) wires `onConnect`
 * through to `useDesktopGitHubConnect` on desktop, which calls
 * `openGitHubConnect` with no `install` flag — ISS-5958 removed install
 * mode from the connect path entirely, so no caller can opt into it. Since
 * PLN-1742 M5 the desktop opener sends that to the web Clerk linking page
 * (`/connect/github/link`), which attaches GitHub to the user's Closedloop
 * sign-in account: a per-user authorization, not an installation.
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
 * The old "never by driving your local gh or git" claim was removed here
 * (not gated): it was already false — the desktop gateway's local `gh` and
 * ambient `git` credential mechanisms remain by design (ISS-6983).
 *
 * The words themselves now live in `GITHUB_CONNECT_PROMPT_COPY` (ISS-5958), one
 * entry per action, so the Reconnect variant cannot acquire a second spelling
 * and the Connect wording above stays the single thing to protect.
 *
 * Surface-agnostic: the host wires `onConnect` to the platform connect route and
 * owns the in-flight state. Connect once — the resulting `GitHubUserConnection`
 * is org+user-scoped and live across desktop, web, and multiplayer, so there is
 * no separate per-surface GitHub integration to repeat.
 */
export function ConnectGitHubPrompt({
  action = GitHubConnectAction.Connect,
  onConnect,
  connecting = false,
  error = null,
  grants = DEFAULT_GRANTS,
  headingId,
}: ConnectGitHubPromptProps) {
  const copy = GITHUB_CONNECT_PROMPT_COPY[action];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      {/* Plain mark, no bordered chip: two stops earlier in this same flow the
          transition panel renders a bare size-6 GitHub mark, and an icon boxed
          in its own container is the template look we keep pulling out of
          screens. One treatment for one mark, across the whole flow. */}
      <GitHubLogo className="size-6" />
      {copy.eyebrow ? (
        <p className="mt-4 font-semibold text-primary text-xs uppercase tracking-wider">
          {copy.eyebrow}
        </p>
      ) : null}
      <h1
        className={cn(
          "font-semibold text-2xl tracking-tight",
          copy.eyebrow ? "mt-1.5" : "mt-4"
        )}
        id={headingId}
      >
        {copy.heading}
      </h1>
      <p className="mx-auto mt-2 max-w-sm text-pretty text-muted-foreground text-sm leading-relaxed">
        {copy.body}
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
        {connecting ? <Loader2 className="animate-spin" /> : <GitHubLogo />}
        {copy.ctaLabel}
      </Button>
      <ConnectGitHubError error={error} />
      <p className="mt-3 text-muted-foreground text-xs">{copy.footnote}</p>
    </div>
  );
}

/**
 * One connect-handoff failure line, announced, or nothing.
 *
 * Its own component because two renders in this flow have to show it and they
 * must not spell it twice: the prompt above, and the step's "checking your
 * connection" state, which a reader reaches the instant they come back from the
 * browser — the one moment a failure message matters most, and the one where a
 * status re-read that folds to `null` would otherwise swallow it (ISS-10990).
 */
export function ConnectGitHubError({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return (
    <p className="mt-3 text-destructive text-xs" role="alert">
      {error}
    </p>
  );
}
