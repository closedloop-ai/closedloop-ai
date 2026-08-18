"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import type { LucideIcon } from "lucide-react";

/**
 * The single generic "gated metric" affordance: an explanation that a KPI card's
 * value needs an action — connecting GitHub, signing in — before it can populate,
 * plus an optional CTA the surface owns. One `variant` prop selects the layout
 * (`card` inline / `centered` page-shell / `banner` above a KPI row); the banner
 * is built on the design-system `Alert`.
 *
 * Extracted (FEA-3574) so the Branches slice's `ConnectGitHubIndicator` and the
 * Sessions slice's `SessionsSignInIndicator` are thin wrappers over ONE
 * layout/typography/spacing source instead of two hand-kept copies that drift on
 * the next copy or spacing fix. Each wrapper supplies only its own icon,
 * explanation, and CTA label/verb.
 *
 * The CTA is surface-injected and href-or-handler:
 * - `onAction` wins when provided: the CTA is a button firing it (a desktop shell
 *   IPC action — sign-in or GitHub-App connect). A surface owning an action must
 *   never fall back to `actionHref`, because the desktop renderer's href store
 *   turns that link into an inert in-app navigation — a dead click (FEA-3280).
 * - `actionHref` (only when no `onAction`): a hard-navigation `Link` CTA for the
 *   web shell so OAuth keeps native link semantics and does not prefetch.
 * - neither: the affordance degrades to informational copy only.
 *
 * The icon renders once, beside the explanation — never a second copy inside the
 * CTA button (the button's verb already names the action).
 */
/**
 * The three mutually-exclusive layouts for the affordance (FEA-4037 review). One
 * `variant` prop instead of overlapping `compact`/`banner` booleans, so there is
 * no "banner wins over compact" precedence rule to remember:
 * - `card` — narrow inline layout for a `MetricCard` body (left-aligned, stacked).
 * - `centered` — centered stacked layout for a page-shell empty state.
 * - `banner` — one horizontal `Alert` prompt above a KPI row (icon + copy left,
 *   CTA right), for a SINGLE ask per surface rather than one affordance per card.
 */
export const GatedMetricIndicatorVariant = {
  Card: "card",
  Centered: "centered",
  Banner: "banner",
} as const;
export type GatedMetricIndicatorVariant =
  (typeof GatedMetricIndicatorVariant)[keyof typeof GatedMetricIndicatorVariant];

export type GatedMetricIndicatorProps = {
  /** The eyebrow icon, rendered once beside the explanation. */
  icon: LucideIcon;
  /** One-line explanation of what unlocks the metric. */
  explanation: string;
  /** The CTA verb/label (e.g. "Sign in", "Connect GitHub"). */
  ctaLabel: string;
  /**
   * Surface-owned action handler. When provided the CTA is a button firing it;
   * takes precedence over `actionHref`.
   */
  onAction?: () => void;
  /**
   * Hard-navigation CTA target (web shell only). Ignored when `onAction` is set.
   */
  actionHref?: string;
  /**
   * Which of the three layouts to render (see `GatedMetricIndicatorVariant`).
   * Defaults to `centered` (the page-shell empty state).
   */
  variant?: GatedMetricIndicatorVariant;
  /**
   * Retryable error copy from a failed action attempt (e.g. a browser sign-in
   * that couldn't start/open/redirect/exchange). When set it renders below the
   * explanation in the destructive tone, and the CTA stands as the retry — so a
   * failed action never leaves the affordance silently unchanged (FEA-3574
   * review). In the `banner` variant a set error also flips the whole prompt to
   * the `Alert` `error` tone so the failure reads at a glance. Cleared by the
   * surface once a retry is in flight or succeeds.
   */
  error?: string | null;
  className?: string;
};

export function GatedMetricIndicator({
  icon: Icon,
  explanation,
  ctaLabel,
  onAction,
  actionHref,
  variant = GatedMetricIndicatorVariant.Centered,
  error,
  className,
}: GatedMetricIndicatorProps) {
  const compact = variant === GatedMetricIndicatorVariant.Card;
  const cta = onAction ? (
    <Button onClick={onAction} size="sm" type="button" variant="outline">
      {ctaLabel}
    </Button>
  ) : null;
  const linkCta =
    !onAction && actionHref ? (
      <Button asChild size="sm" variant="outline">
        <Link href={actionHref} prefetch={false}>
          {ctaLabel}
        </Link>
      </Button>
    ) : null;
  // The retry error copy. In the `banner` variant the surrounding `Alert` already
  // owns the assertive `role="alert"` and the error tone, so the inner span is
  // plain text; the `card`/`centered` variants are bare divs, so their error span
  // keeps its own `role="alert"` + `text-destructive` tone to announce and stand
  // out. `bannerErrorNode` therefore drops the role to avoid a double alert role.
  const errorNode = error ? (
    <span className="text-destructive" role="alert">
      {error}
    </span>
  ) : null;
  const bannerErrorNode = error ? <span>{error}</span> : null;

  // Banner (FEA-4037): a single horizontal ask above a KPI row, built on the
  // design-system `Alert` (FEA-4067 review) instead of a hand-kept tinted box —
  // the leading `Icon` slots into `Alert`'s icon column, the copy + right-pinned
  // CTA go in `AlertDescription`, and the retry error renders on its own line
  // beneath. `rounded-xl` matches the Card row it introduces (Alert defaults to
  // `rounded-md`), and a set error flips the whole prompt to the `error` tone so
  // a failed sign-in reads at a glance rather than as red text in a muted box.
  if (variant === GatedMetricIndicatorVariant.Banner) {
    return (
      <Alert
        className={cn(
          "grid-cols-[calc(var(--spacing)*4)_1fr] rounded-xl",
          className
        )}
        variant={error ? "error" : "default"}
      >
        <Icon />
        <AlertDescription className="w-full">
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="min-w-0">{explanation}</span>
            {cta}
            {linkCta}
          </div>
          {bannerErrorNode}
        </AlertDescription>
      </Alert>
    );
  }

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
        <Icon className="size-3.5 shrink-0" />
        <span className={compact ? "min-w-0 leading-snug" : undefined}>
          {explanation}
        </span>
      </span>
      {cta}
      {linkCta}
      {errorNode}
    </div>
  );
}
