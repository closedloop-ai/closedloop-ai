"use client";

// Cross-slice import (shared gated-metric affordance): the sign-in and
// connect-GitHub indicators are the same compact gated-metric layout differing
// only in icon/copy/verb, so both compose the one shared component instead of
// hand-keeping two copies (FEA-3574).
import {
  GatedMetricIndicator,
  GatedMetricIndicatorVariant,
} from "@repo/app/shared/components/gated-metric-indicator";
import { LogInIcon } from "lucide-react";

/**
 * The sign-in affordance for a cloud-only Sessions KPI card in its signed-out
 * (state 2) auth state (FEA-3574). It explains that the delivery metric needs a
 * signed-in cloud session to populate, and — when the surface owns a sign-in
 * action — renders an accessible CTA that fires it.
 *
 * A thin wrapper over the shared `GatedMetricIndicator` (the compact gated-metric
 * template): it supplies the login icon, the sign-in copy, and the "Sign in"
 * verb; the layout/typography/spacing live in the shared component so this and
 * the Branches slice's `ConnectGitHubIndicator` cannot drift. The two differ
 * deliberately in *what* they ask for — this asks to sign in, that asks to
 * connect GitHub — because a signed-out Sessions user needs a cloud session
 * before the delivery cards can compute at all. When authenticated-but-empty
 * (state 3), the card renders a plain neutral detail with NO CTA instead of this
 * indicator, so the two empty states never look alike.
 *
 * The CTA is surface-injected: the desktop shell passes its browser OAuth
 * `beginSignIn` IPC as `onSignIn`; a surface without a sign-in action (the web
 * Sessions page is already authenticated, so it never reaches this state) omits
 * the handler and the affordance degrades to informational copy only.
 */
export type SessionsSignInIndicatorProps = {
  /**
   * Optional sign-in handler. When provided the CTA becomes a button that fires
   * it (the desktop shell's browser OAuth flow); when omitted the affordance is
   * informational only.
   */
  onSignIn?: () => void;
  /**
   * Retryable error copy from the last failed sign-in attempt (FEA-3574 review).
   * When set it renders below the copy in the destructive tone and the CTA
   * stands as the retry, so a `beginSignIn` failure never leaves the card
   * silently unchanged.
   */
  signInError?: string | null;
  /**
   * FEA-4037: render the single horizontal banner layout (icon + copy left, CTA
   * right) for ONE ask above the KPI row, rather than the compact per-card
   * affordance. When set, the explanation uses the row-scoped copy so it reads as
   * a single prompt for the whole delivery set, not a per-metric caption.
   */
  banner?: boolean;
  className?: string;
};

export const SESSIONS_SIGN_IN_EXPLANATION = "Sign in to light up this metric.";
// Banner copy names the ask once and lets the labels below do the naming — the
// three delivery cards sit directly under it, so re-listing (and re-casing) each
// metric name here is redundant (FEA-4037 review).
export const SESSIONS_SIGN_IN_BANNER_EXPLANATION =
  "Sign in to see your delivery metrics.";

export function SessionsSignInIndicator({
  onSignIn,
  signInError,
  banner = false,
  className,
}: SessionsSignInIndicatorProps) {
  return (
    <GatedMetricIndicator
      className={className}
      ctaLabel="Sign in"
      error={signInError}
      explanation={
        banner
          ? SESSIONS_SIGN_IN_BANNER_EXPLANATION
          : SESSIONS_SIGN_IN_EXPLANATION
      }
      icon={LogInIcon}
      onAction={onSignIn}
      variant={
        banner
          ? GatedMetricIndicatorVariant.Banner
          : GatedMetricIndicatorVariant.Card
      }
    />
  );
}
