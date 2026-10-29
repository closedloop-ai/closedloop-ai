"use client";

// Cross-slice import (shared gated-metric affordance): the layout, typography
// and spacing live in one shared component rather than in each surface that
// gates a metric (FEA-3574).
import {
  GatedMetricIndicator,
  GatedMetricIndicatorVariant,
} from "@repo/app/shared/components/gated-metric-indicator";
import { PlugIcon } from "lucide-react";
import { GitHubConnectAction } from "../../github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "../../github/lib/github-connect-copy";
import type { GitHubConnectTarget } from "../../github/lib/github-connect-target";

/**
 * The single canonical "connect GitHub" affordance for the Branches slice
 * (Epic B / B0). It explains that a gated metric needs GitHub enrichment to
 * populate. Surface adapters own whether that becomes a hard-navigation link,
 * a desktop IPC action, or informational copy only.
 *
 * A thin wrapper over the shared `GatedMetricIndicator` (the compact gated-metric
 * template): it supplies the "plug/connect" icon (lucide 1.x removed brand/logo
 * icons, so a generic connect icon stands in for the GitHub mark — the `card`
 * placement draws none, see ISS-11476), the connect copy, and the verb; the
 * layout/typography/spacing live in the shared component. ISS-7866 made this the ONLY wrapper over it — the Sessions
 * strip's sign-in variant is gone, and this affordance now answers the
 * signed-out case on every surface too.
 *
 * Consumed by both the gated KPI cards (B6, `compact`) and the page-shell
 * `github-not-connected` empty state (B2, stacked). The connect destination is
 * ONE value ({@link GitHubConnectTarget}), which is what stops a surface owning
 * a connect action from also carrying a navigation href: the desktop renderer's
 * href store turns that link into an inert in-app navigation — a dead click that
 * never reaches the connect flow (FEA-3280). ISS-5958 made that shape a compile
 * error rather than a comment. Omit `connect` and the affordance is
 * informational only.
 */
export type ConnectGitHubIndicatorProps = {
  /**
   * What the control performs and how this surface performs it, which together
   * decide its label, explanation, and click behavior (ISS-5958). A surface
   * that cannot resolve an action yet falls back to a first-time connect.
   */
  connect?: GitHubConnectTarget;
  /**
   * Which layout to render, passed straight through to the shared component.
   *
   * ONE prop rather than the `compact` / `banner` booleans this used to take.
   * The ISS-7866 review caught what those cost: `compact` named two different
   * placements — a `MetricCard`'s caption slot AND a host's own bordered strip —
   * so narrowing it to a bare verb for the first silently emptied the second,
   * and three Branches strips shipped as a control with nothing saying what it
   * unlocks. Naming the placement makes that a choice a callsite has to make
   * rather than one it inherits. Same reason FEA-4037's review collapsed the
   * shared component's own booleans.
   */
  variant?: GatedMetricIndicatorVariant;
  /**
   * ISS-10645: what this ask SPEAKS FOR, when the variant cannot say. A
   * `centered` placement is a metric tile's replaced body on Insights and a
   * whole stalled LIST on Branches, and "light up this metric" is a sentence
   * with no referent in the second. Defaults to the metric scope, so every
   * existing call site keeps the words it ships today.
   */
  scope?: GitHubConnectScope;
  /**
   * `card` placement only: draw the prototype's supporting sentence after the
   * link. OFF by default, because the Insights grid's own KPI tiles read a
   * provider-PR population with no authoring-session link at all
   * (`METRIC_INFO["kpi:merged"]`), so the sentence would be false there.
   *
   * ISS-11476 scoped it to the three dashboard metric cards (codex + tamsinb
   * review on #8169); the ISS-12638 operator instruction widened the opt-in to
   * every GitHub-dependent card ask — the dashboard's chart tiles and AI Impact
   * metrics, the Sessions delivery strip, and the Branches summary strip.
   */
  withSupportingCopy?: boolean;
  className?: string;
};

/** Which population one connect ask is made on behalf of. */
export const GitHubConnectScope = {
  Metric: "metric",
  List: "list",
} as const;
export type GitHubConnectScope =
  (typeof GitHubConnectScope)[keyof typeof GitHubConnectScope];

export function ConnectGitHubIndicator({
  connect,
  scope = GitHubConnectScope.Metric,
  variant = GatedMetricIndicatorVariant.Centered,
  withSupportingCopy = false,
  className,
}: ConnectGitHubIndicatorProps) {
  const copy =
    GITHUB_CONNECT_COPY[connect?.action ?? GitHubConnectAction.Connect];
  const isCard = variant === GatedMetricIndicatorVariant.Card;
  return (
    <GatedMetricIndicator
      actionHref={connect?.href}
      className={className}
      // ISS-11476: a gated card's ask is a link inside a sentence, so it takes
      // the prototype's "Connect to GitHub" wording where the prototype supplies
      // one; an action it never drew keeps its approved verb, and every other
      // placement keeps the bare verb because it sits beside its own copy.
      ctaLabel={isCard ? (copy.cardCtaLabel ?? copy.ctaLabel) : copy.ctaLabel}
      // The banner speaks for a whole SECTION, so it takes the section-scoped
      // sentence; every other placement speaks for one metric.
      explanation={connectExplanation({ copy, scope, variant })}
      icon={PlugIcon}
      onAction={connect?.onConnect}
      supportingCopy={
        isCard && withSupportingCopy ? copy.cardSupportingCopy : undefined
      }
      variant={variant}
    />
  );
}

/**
 * The sentence this placement should carry. Variant answers it where the
 * placement IS the scope (a banner speaks for a section); `scope` answers it
 * where one variant serves two populations (ISS-10645).
 */
function connectExplanation({
  copy,
  scope,
  variant,
}: {
  copy: (typeof GITHUB_CONNECT_COPY)[GitHubConnectAction];
  scope: GitHubConnectScope;
  variant: GatedMetricIndicatorVariant;
}): string {
  if (variant === GatedMetricIndicatorVariant.Banner) {
    return copy.deliveryBannerExplanation;
  }
  if (scope === GitHubConnectScope.List) {
    return copy.listUnavailableExplanation;
  }
  return copy.gatedMetricExplanation;
}
