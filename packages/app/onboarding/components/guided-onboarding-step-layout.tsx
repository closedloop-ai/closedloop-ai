"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

export function GuidedOnboardingStepLayout({
  annotation,
  persistentActions,
  body,
  brand,
  description,
  eyebrow,
  footer,
  title,
}: {
  annotation?: ReactNode;
  persistentActions?: ReactNode;
  body?: ReactNode;
  brand: ReactNode;
  description: ReactNode;
  eyebrow: string;
  footer: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={GUIDED_ONBOARDING_STEP_BODY_CLASS}>
      <div className={GUIDED_ONBOARDING_STEP_SCROLL_CLASS}>
        <div className="h-7 w-fit">{brand}</div>
        <div className="mt-14 w-full">
          <p className="font-semibold text-primary text-xs uppercase tracking-wider">
            {eyebrow}
          </p>
          <div className="relative">
            <GuidedOnboardingPhaseHeading className="mt-3 font-semibold text-3xl tracking-tight">
              {title}
            </GuidedOnboardingPhaseHeading>
            {annotation}
          </div>
          <DialogDescription asChild>
            <div className="mt-4 w-full text-base leading-7">{description}</div>
          </DialogDescription>
          {body}
        </div>
      </div>
      {persistentActions ? (
        <div className="shrink-0 px-7 sm:px-10">{persistentActions}</div>
      ) : null}
      <div
        className={cn(
          GUIDED_ONBOARDING_STEP_FOOTER_CLASS,
          persistentActions && "mt-3 sm:mt-3"
        )}
      >
        {footer}
      </div>
    </div>
  );
}

export function GuidedOnboardingBackButton({
  className = "w-full sm:w-56",
  disabled = false,
  onBack,
}: {
  className?: string;
  /**
   * Locks Back while the step's own write is in flight. Leaving it clickable
   * lets the reader post a Back that the in-flight completion then beats: the
   * completion advances the run and the Back is rejected as stale, so trying to
   * LEAVE a step lands them on the next one (whitlockk, ISS-11253 review).
   */
  disabled?: boolean;
  onBack?: () => void;
}) {
  if (!onBack) {
    return null;
  }

  return (
    <Button
      className={cn(className, "justify-start px-0")}
      disabled={disabled}
      onClick={onBack}
      size="lg"
      type="button"
      variant="ghost"
    >
      <ArrowLeftIcon />
      Back
    </Button>
  );
}

export function GuidedOnboardingPrimaryPlaceholder({
  className,
}: {
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-10 w-full shrink-0 sm:w-56", className)}
      data-slot="ftue-primary-action-placeholder"
    />
  );
}

/**
 * Every phase heading in `GuidedOnboardingDialog`, and the reason it is NOT
 * focusable.
 *
 * It used to carry `tabIndex={-1}` so the shell could land focus here on a body
 * change (WCAG 2.4.3 Focus Order). ISS-11315 removed that: the operator
 * reported the focus ring the browser painted for a mouse user arriving at a
 * step they never touched, and ruled the heading must not take focus or show a
 * border on any arrival. Both jobs that focus move did are kept, by the dialog
 * rather than by this element — it lands focus on the dialog CONTENT, and a
 * polite live region carries the step announcement (`useAnnounceBodyChange`).
 *
 * A body owns whether it renders a heading and what it looks like; it does not
 * get to make that heading focusable, because one body doing so brings the ring
 * back for that step alone. Stated once here so a tenth phase cannot reintroduce
 * it — and the restoring screen is one of these too, not a phase but a body the
 * shell arrives at by name, so it takes the same heading.
 */
export function GuidedOnboardingPhaseHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  // ISS-11315: NOT focusable. It carried `tabIndex={-1}` so the dialog could
  // land focus on it after a step change, and the browser painted its focus
  // ring for a mouse user arriving at a step they never touched — reported by
  // the operator against a fresh install. The announcement that focus move
  // existed for is preserved by the dialog itself (see
  // `useAnnounceBodyChange`), so the attribute is gone rather than restyled:
  // an element that cannot take focus cannot be ringed, on any arrival, under
  // any `:focus` / `:focus-visible` heuristic.
  return <DialogTitle className={className}>{children}</DialogTitle>;
}

/**
 * The three parts of a step's frame: the padded column, the region that
 * scrolls, and the action row.
 *
 * The action row is IN FLOW, and that is the whole contract. It used to be
 * `absolute … bg-background` over the scroll body, with a fixed `pb` reserve
 * that was supposed to keep the last content row clear of it. Nothing enforced
 * that reserve, and it only ever described the bottom of the scroll range: at
 * every other scroll position the row painted an opaque band of `--background`
 * across the dialog, hiding whatever sat behind it — on the sync step, half of
 * the third privacy card, with no scrollbar contrast to say the content was
 * still there (ISS-10885). A row that occupies its own space cannot paint over
 * anything, so the reserve, the band, and the drift between them all go.
 *
 * Exported rather than restated because four phases cannot compose
 * `GuidedOnboardingStepLayout` — create-organization needs a `<form>` root,
 * choose-organization a centred card, and welcome and GitHub each build their
 * own body. Those last two carry a single action, and they do NOT use the same
 * row: welcome's Start button takes the end-aligned single-action row, while
 * GitHub's lone Back button stays on the shared row, where a single flex child
 * under `justify-between` sits at the start — which is where Back belongs.
 * Import these; do not retype them.
 */
export const GUIDED_ONBOARDING_STEP_BODY_CLASS =
  "flex h-full min-h-0 flex-col py-7 sm:py-10";

/**
 * The side gutters live HERE, not on the frame, and that is load-bearing.
 * `overflow-y: auto` computes `overflow-x` to `auto` as well, so this region
 * clips horizontally: a full-bleed focusable child — the invite step's email
 * field, any `w-full` input — would lose the outside-the-box focus ring the
 * design system draws with no offset. The padding is what gives that ring room.
 */
export const GUIDED_ONBOARDING_STEP_SCROLL_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-y-auto px-7 sm:px-10";

export const GUIDED_ONBOARDING_STEP_FOOTER_CLASS =
  "mt-7 flex shrink-0 flex-col-reverse items-stretch gap-2 px-7 sm:mt-10 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-10";

/** A single-action row on the same frame, aligned to the end of the dialog. */
export const GUIDED_ONBOARDING_STEP_SINGLE_ACTION_FOOTER_CLASS =
  "mt-7 flex shrink-0 justify-end px-7 sm:mt-10 sm:px-10";
