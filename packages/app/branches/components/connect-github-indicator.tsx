"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { PlugIcon } from "lucide-react";

/**
 * The single canonical "connect GitHub" affordance for the Branches slice
 * (Epic B / B0). It explains that a gated metric needs GitHub enrichment to
 * populate — it is NOT an OAuth flow and has no GitHub/data dependency, so it
 * renders identically on the unauthenticated local desktop path.
 *
 * Consumed by both the gated KPI cards (B6, `compact`) and the page-shell
 * `github-not-connected` empty state (B2, stacked). When `onConnect` is
 * provided a CTA button fires it; otherwise the affordance is informational.
 *
 * Note: lucide 1.x removed brand/logo icons (no GitHub mark), so a generic
 * "plug/connect" icon stands in for the integration.
 */
export type ConnectGitHubIndicatorProps = {
  /**
   * Single-line (compact) layout for inline placement such as a gated
   * `MetricCard` body; stacked + centered otherwise (page-shell empty state).
   */
  compact?: boolean;
  /**
   * Optional connect handler. When provided, a "Connect GitHub" CTA button
   * fires it; when omitted, the affordance is informational only (no button).
   */
  onConnect?: () => void;
  className?: string;
};

const EXPLANATION = "Connect GitHub to light up this metric.";

export function ConnectGitHubIndicator({
  compact = false,
  onConnect,
  className,
}: ConnectGitHubIndicatorProps) {
  return (
    <div
      className={cn(
        "flex text-[var(--muted-foreground)] text-xs",
        compact
          ? "flex-row items-center gap-2"
          : "flex-col items-center gap-2 text-center",
        className
      )}
    >
      <span className="flex items-center gap-1.5">
        <PlugIcon className="size-3.5 shrink-0" />
        <span>{EXPLANATION}</span>
      </span>
      {onConnect ? (
        <Button onClick={onConnect} size="sm" type="button" variant="outline">
          <PlugIcon className="size-3.5" />
          Connect GitHub
        </Button>
      ) : null}
    </div>
  );
}
