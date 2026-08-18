"use client";

// Cross-slice import (shared gated-metric affordance): the connect-GitHub and
// sign-in indicators are the same compact gated-metric layout differing only in
// icon/copy/verb, so both compose the one shared component instead of
// hand-keeping two copies (FEA-3574).
import {
  GatedMetricIndicator,
  GatedMetricIndicatorVariant,
} from "@repo/app/shared/components/gated-metric-indicator";
import { PlugIcon } from "lucide-react";

/**
 * The single canonical "connect GitHub" affordance for the Branches slice
 * (Epic B / B0). It explains that a gated metric needs GitHub enrichment to
 * populate. Surface adapters own whether that becomes a hard-navigation link,
 * a desktop IPC action, or informational copy only.
 *
 * A thin wrapper over the shared `GatedMetricIndicator` (the compact gated-metric
 * template): it supplies the "plug/connect" icon (lucide 1.x removed brand/logo
 * icons, so a generic connect icon stands in for the GitHub mark), the connect
 * copy, and the "Connect GitHub" verb; the layout/typography/spacing live in the
 * shared component so this and the Sessions slice's `SessionsSignInIndicator`
 * cannot drift.
 *
 * Consumed by both the gated KPI cards (B6, `compact`) and the page-shell
 * `github-not-connected` empty state (B2, stacked). When `onConnect` is provided
 * a CTA button fires it; a surface owning a connect action must never fall back
 * to `connectHref`, because the desktop renderer's href store turns that link
 * into an inert in-app navigation — a dead click that never reaches the connect
 * flow (FEA-3280). When both are omitted, the affordance is informational only.
 */
export type ConnectGitHubIndicatorProps = {
  /**
   * Narrow-card layout for inline placement such as a gated `MetricCard` body;
   * centered page-shell layout otherwise.
   */
  compact?: boolean;
  /**
   * Optional hard-navigation target. Used by the web shell so OAuth keeps native
   * link semantics and does not prefetch.
   */
  connectHref?: string;
  /**
   * Optional connect handler. When provided it takes precedence over
   * `connectHref` (see FEA-3280 note above).
   */
  onConnect?: () => void;
  className?: string;
};

const EXPLANATION = "Connect GitHub to light up this metric.";

export function ConnectGitHubIndicator({
  compact = false,
  connectHref,
  onConnect,
  className,
}: ConnectGitHubIndicatorProps) {
  return (
    <GatedMetricIndicator
      actionHref={connectHref}
      className={className}
      ctaLabel="Connect GitHub"
      explanation={EXPLANATION}
      icon={PlugIcon}
      onAction={onConnect}
      variant={
        compact
          ? GatedMetricIndicatorVariant.Card
          : GatedMetricIndicatorVariant.Centered
      }
    />
  );
}
