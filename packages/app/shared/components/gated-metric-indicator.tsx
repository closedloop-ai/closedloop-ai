"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The single generic "gated metric" affordance: an explanation that a KPI card's
 * value needs an action — connecting GitHub, signing in — before it can populate,
 * plus an optional CTA the surface owns. One `variant` prop selects the layout
 * (`card` inline / `centered` page-shell / `banner` above a KPI row); the banner
 * is built on the design-system `Alert`.
 *
 * Extracted (FEA-3574) so a surface's gated affordance is a thin wrapper over
 * ONE layout/typography/spacing source instead of hand-kept copies that drift on
 * the next copy or spacing fix. A wrapper supplies only its own icon,
 * explanation, and CTA label/verb.
 *
 * ISS-7866 left exactly one wrapper, `ConnectGitHubIndicator`. The Sessions
 * slice had a second, `SessionsSignInIndicator`, asking a signed-out reader to
 * sign in while every other surface asked the same reader to connect GitHub —
 * one wall, two verbs, decided by which screen they happened to be on.
 *
 * The CTA is surface-injected and href-or-handler:
 * - `onAction` wins when provided: the CTA is a button firing it (a desktop shell
 *   IPC action — the GitHub connect handoff). A surface owning an action must
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
 * - `card` — an inline sentence for a `MetricCard` detail slot: a foreground,
 *   underlined link followed by `supportingCopy` in the muted tone. ISS-11476's
 *   reporter supplied the `web-master` dashboard prototype as the expected
 *   treatment, which supersedes ISS-7866's bare-verb-and-nothing-else reading of
 *   `pre-auth-desktop-onboarding`. It stays one `text-xs` line of running copy,
 *   so the height concern ISS-7866 dropped the old block sentence over does not
 *   return: no icon, no button chrome, no second line.
 * - `centered` — centered stacked layout for a page-shell empty state or a
 *   chart tile's replaced body, both of which have room and no label of their own.
 * - `banner` — one horizontal `Alert` prompt above a KPI row (icon + copy left,
 *   CTA right), for a SINGLE ask per surface rather than one affordance per card.
 *
 * A fourth, `notice` — the same content stacked LEFT for a host that owned its
 * own bordered strip — existed for the Branches list and detail asks alone.
 * ISS-11274 removed both, leaving it with no production host, so it was deleted
 * with them rather than left as an unmounted layout.
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
  /** The CTA verb/label (e.g. "Connect to GitHub"). */
  ctaLabel: string;
  /**
   * `card` variant only: the sentence that follows the CTA inline, in the muted
   * tone (ISS-11476). Rendered only when the surface owns a control — with no
   * control the slot falls back to `explanation`, which is a whole sentence
   * already.
   */
  supportingCopy?: string;
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
  supportingCopy,
  onAction,
  actionHref,
  variant = GatedMetricIndicatorVariant.Centered,
  error,
  className,
}: GatedMetricIndicatorProps) {
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

  // Card (ISS-11476): the inline ask the reporter's `web-master` dashboard
  // prototype draws — an underlined foreground link inside one muted sentence.
  // It stays a single `text-xs` line, which is what keeps a gated card the
  // HEIGHT of a live one: that row-height contract is ISS-7866's, and it is the
  // reason there is no icon and no button chrome here, only running copy.
  if (variant === GatedMetricIndicatorVariant.Card) {
    return (
      <div className={cn("flex min-w-0 flex-col items-start gap-1", className)}>
        <span className="text-[var(--muted-foreground)] text-xs leading-5">
          {renderCardCta({ actionHref, ctaLabel, explanation, onAction })}
          {cardSupportingCopy({ actionHref, onAction, supportingCopy })}
        </span>
        {errorNode}
      </div>
    );
  }

  // Banner (FEA-4037): a single horizontal ask above a KPI row, built on the
  // design-system `Alert` (FEA-4067 review) instead of a hand-kept tinted box —
  // the leading `Icon` slots into `Alert`'s icon column, the copy + right-pinned
  // CTA go in `AlertDescription`, and the retry error renders on its own line
  // beneath. `rounded-xl` matches the Card row it introduces (Alert defaults to
  // `rounded-md`), and a set error flips the whole prompt to the `error` tone so
  // a failed handoff reads at a glance rather than as red text in a muted box.
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

  // `centered`, the default: a page-shell empty state or a chart tile's replaced
  // body, both of which own the whole area and read centred.
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 text-center text-[var(--muted-foreground)] text-xs",
        className
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" />
        <span>{explanation}</span>
      </span>
      {cta}
      {linkCta}
      {errorNode}
    </div>
  );
}

/**
 * The `card` variant's CTA: an underlined foreground link sitting inside the
 * slot's own sentence (ISS-11476). `linkForeground` is the design system's
 * in-running-text link tone — the `link` variant's `text-primary` is what read
 * as a blue call to action beside the prototype's black one — and the underline
 * is always drawn rather than hover-only, because it is the only thing marking
 * the words as a control.
 *
 * No icon: the prototype draws none, and the plug glyph the connect wrapper
 * supplies is what the ISS-11476 reporter saw as a blue chip on three cards.
 * The other two variants still render it beside their explanation.
 *
 * Falls back to the explanation when the surface owns neither an action nor an
 * href, so a card that cannot offer the fix still says why it is dark instead
 * of rendering an empty slot — which is what the web dashboard shipped before
 * ISS-7866, an ask with no way to act on it.
 */
function renderCardCta({
  actionHref,
  ctaLabel,
  explanation,
  onAction,
}: {
  actionHref?: string;
  ctaLabel: string;
  explanation: string;
  onAction?: () => void;
}): ReactNode {
  if (onAction) {
    return (
      <Button
        className={CARD_CTA_CLASS_NAME}
        onClick={onAction}
        size="sm"
        type="button"
        variant="linkForeground"
      >
        {ctaLabel}
      </Button>
    );
  }
  if (actionHref) {
    return (
      <Button
        asChild
        className={CARD_CTA_CLASS_NAME}
        size="sm"
        variant="linkForeground"
      >
        <Link href={actionHref} prefetch={false}>
          {ctaLabel}
        </Link>
      </Button>
    );
  }
  return <span>{explanation}</span>;
}

/**
 * The sentence after the `card` CTA, and only when there IS a CTA for it to
 * follow: with no control {@link renderCardCta} already renders a whole
 * explanation sentence, and appending a fragment written to complete a link
 * would leave two sentences run together.
 */
function cardSupportingCopy({
  actionHref,
  onAction,
  supportingCopy,
}: {
  actionHref?: string;
  onAction?: () => void;
  supportingCopy?: string;
}): ReactNode {
  if (!(supportingCopy && (onAction || actionHref))) {
    return null;
  }
  return ` ${supportingCopy}`;
}

/**
 * The card CTA's shape: baseline-aligned and stripped of button padding and
 * height so it sits in the surrounding sentence as text, at the slot's own
 * `text-xs` size.
 */
// `underline-offset-2` is the prototype's own offset and has to be spelled
// here: the `linkForeground` button variant sets `underline-offset-4`, and
// without an override that wins (tamsinb review on #8169).
const CARD_CTA_CLASS_NAME =
  "h-auto p-0 align-baseline font-medium text-xs underline decoration-border underline-offset-2 hover:decoration-foreground";
