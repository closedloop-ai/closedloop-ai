"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { useId } from "react";

/**
 * Copy for {@link OnboardingStatusUnavailable}. It says what could not be
 * checked and never why: one card covers a network error, a server error, and a
 * response this bundle could not read, and any cause it named would be false for
 * two of the three.
 */
export const ONBOARDING_STATUS_UNAVAILABLE_COPY = {
  title: "We couldn't check your setup",
  description:
    "We check it before showing this page. Retry, or reload if this keeps happening.",
  retryLabel: "Retry",
  retryingLabel: "Retrying…",
} as const;

/**
 * The recoverable state for an onboarding status that has no settled answer
 * after a terminal failure (ISS-7828, PRD-682 R3). The web onboarding guard and
 * page render it in place of their content, so an unknown status is neither
 * treated as finished nor left as a blank page. It carries no placement of its
 * own: each mount positions it where its content would have been.
 *
 * Lives in `packages/app` so it can carry a story (Storybook does not scan
 * `apps/app`).
 *
 * Retry stays focusable while a retry is in flight (`aria-disabled`, not
 * `disabled`): it is the only control on the screen, and disabling it under
 * the keyboard drops focus to the page body with nothing to return it.
 */
export function OnboardingStatusUnavailable({
  onRetry,
  retrying,
}: {
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  const titleId = useId();
  const copy = ONBOARDING_STATUS_UNAVAILABLE_COPY;

  return (
    <Alert aria-labelledby={titleId} className="max-w-md" variant="error">
      <AlertCircleIcon />
      <AlertTitle>
        <h2 id={titleId}>{copy.title}</h2>
      </AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        <div className="mt-3 flex gap-2">
          <Button
            aria-disabled={retrying}
            className="aria-disabled:opacity-50"
            onClick={retrying ? undefined : onRetry}
            size="sm"
            type="button"
          >
            {retrying ? <Loader2Icon className="animate-spin" /> : null}
            {retrying ? copy.retryingLabel : copy.retryLabel}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
