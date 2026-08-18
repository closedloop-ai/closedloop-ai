import { GitHubMark } from "@repo/design-system/components/ui/brand-icons";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

type AuthTransitionPanelProps = {
  /** Sentence-case heading. The only h1 on a transitional stop. */
  title: string;
  description?: string;
  /** Recovery affordance, rendered below the copy. */
  action?: ReactNode;
  /** Spins, and marks the live region busy. */
  busy?: boolean;
  /** The filled GitHub mark - the continuity cue back to the CTA. */
  showGitHubMark?: boolean;
};

/**
 * THE waiting treatment. Every "hold on, we're moving you" moment in this flow
 * uses this one block: /connect/github, /sso-callback, the failure branch off
 * either, and the hand-back to the desktop.
 *
 * Production now ships this as a shared component
 * (packages/app/onboarding/components/auth-transition-panel.tsx) across the two
 * transitional routes. The device consent screen is still its own spelling - a
 * left-aligned Card with an inline size-4 spinner - so the count went from three
 * to two, not to one. Closing that gap is follow-up work, not done.
 *
 * Width is deliberately not set here. The auth layout already clamps its column,
 * so a local max-width would either be inert or fight it.
 */
export const AuthTransitionPanel = ({
  title,
  description,
  action,
  busy = false,
  showGitHubMark = false,
}: AuthTransitionPanelProps) => (
  <div
    aria-busy={busy}
    className="flex flex-col items-center gap-4 text-center"
    role="status"
  >
    {showGitHubMark ? (
      <GitHubMark className="size-6 text-muted-foreground" />
    ) : null}
    <div className="flex flex-col gap-1.5">
      <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
    </div>
    {busy ? (
      <Loader2
        aria-hidden="true"
        className="size-6 animate-spin text-muted-foreground"
      />
    ) : null}
    {action}
  </div>
);
