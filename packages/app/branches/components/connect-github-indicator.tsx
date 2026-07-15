"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { PlugIcon } from "lucide-react";

/**
 * The single canonical "connect GitHub" affordance for the Branches slice
 * (Epic B / B0). It explains that a gated metric needs GitHub enrichment to
 * populate. Surface adapters own whether that becomes a hard-navigation link,
 * a desktop IPC action, or informational copy only.
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
   * Optional connect handler. When provided, a "Connect GitHub" CTA button
   * fires it; when both `connectHref` and `onConnect` are omitted, the
   * affordance is informational only.
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
    <div
      className={cn(
        "flex text-[var(--muted-foreground)] text-xs",
        compact
          ? "min-w-0 flex-col items-start justify-center gap-2 text-left"
          : "flex-col items-center gap-2 text-center",
        className
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5",
          compact ? "min-w-0" : undefined
        )}
      >
        <PlugIcon className="size-3.5 shrink-0" />
        <span className={compact ? "min-w-0 leading-snug" : undefined}>
          {EXPLANATION}
        </span>
      </span>
      {connectHref ? (
        <Button asChild size="sm" variant="outline">
          <Link href={connectHref} prefetch={false}>
            <PlugIcon className="size-3.5" />
            Connect GitHub
          </Link>
        </Button>
      ) : null}
      {!connectHref && onConnect ? (
        <Button onClick={onConnect} size="sm" type="button" variant="outline">
          <PlugIcon className="size-3.5" />
          Connect GitHub
        </Button>
      ) : null}
    </div>
  );
}
