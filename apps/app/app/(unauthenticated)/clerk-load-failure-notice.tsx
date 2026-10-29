"use client";

import { useClerk } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { type ReactNode, useEffect, useRef } from "react";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";

/**
 * The reported message. A stable literal so a Datadog monitor can key on it,
 * and deliberately silent about WHICH Clerk failure occurred: the status this
 * module gates on is only `error`, so naming `failed_to_load_clerk_js` or
 * `failed_to_load_clerk_ui` here would be a cause it never observed. The RUM
 * error the SDK captures alongside this one carries the code.
 */
const CLERK_LOAD_FAILURE_MESSAGE =
  "Clerk reported an error status on an auth screen";

const FAILURE_TITLE = "Closedloop couldn't finish loading";
const FAILURE_DESCRIPTION =
  "Something blocked this page from loading. Reload to try again.";
const RELOAD_LABEL = "Reload";

/** Clerk's own terminal load-failure status. */
const CLERK_ERROR_STATUS = "error";

/**
 * What a signed-out visitor sees when Clerk fails to load, and the thing that
 * turns that failure into a monitored condition.
 *
 * ISS-11429. Measured on the prod host: `failed_to_load_clerk_ui` on `/sign-up`
 * and `failed_to_load_clerk_js` on several authenticated routes, plus
 * `Loading chunk 26 failed … clerk.closedloop.ai/npm/@clerk/ui@1.33.0`. In every
 * one of them the auth card renders nothing at all — Clerk's embed returns no
 * markup in the error state — so the visitor sits in front of a permanently
 * empty box with no statement that anything went wrong and no way to retry. The
 * screen was lying about its own state, which is the one thing an auth screen
 * must not do.
 *
 * Clerk's status is the gate rather than a timer of our own, so the notice
 * cannot appear on a slow-but-working load and needs no bound to guess at.
 *
 * IT IS THE ONLY THING ON THE SCREEN once it appears, because
 * {@link HideWhenClerkFailed} takes the page's own content down in the same
 * render. `/sso-callback` and `/connect/github` drive an `AuthTransitionPanel`
 * from a phase Clerk's failure never advances, so leaving them up put two
 * contradictory statements side by side: one saying the sign-in is still in
 * progress, the other saying it failed. That is why this owns the page's `h1` —
 * with the page's own panel gone, nothing else states what the screen is.
 *
 * REPORTED ONCE per mount. The gate can re-render while the status holds, and a
 * report per render would turn one broken load into a burst that reads as many
 * incidents. The repo bans a client-side console log for this
 * (`no-client-debug-logging`), so the existing RUM reporter is the channel —
 * the same one both root error boundaries use.
 */
export const ClerkLoadFailureNotice = () => {
  const clerkFailed = useClerkLoadFailed();
  if (clerkFailed) {
    return <ClerkLoadFailurePanel />;
  }
  return null;
};

/**
 * The page's own content, withheld while Clerk is in its terminal error state.
 *
 * ISS-11429 review. Mounted on the LAYOUT so all four screens in this group get
 * one statement instead of four, and gated on the SAME predicate as the notice
 * so the two can never disagree about whether Clerk failed.
 */
export const HideWhenClerkFailed = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const clerkFailed = useClerkLoadFailed();
  if (clerkFailed) {
    return null;
  }
  return children;
};

const ClerkLoadFailurePanel = () => {
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current) {
      return;
    }
    reportedRef.current = true;
    reportNextjsError(new Error(CLERK_LOAD_FAILURE_MESSAGE), {
      source: RumErrorSource.ClerkLoad,
    });
  }, []);

  return (
    <div className="flex flex-col gap-3 text-center" role="alert">
      <h1 className="font-semibold text-2xl tracking-tight">{FAILURE_TITLE}</h1>
      <p className="text-muted-foreground text-sm">{FAILURE_DESCRIPTION}</p>
      <Button onClick={() => window.location.reload()}>{RELOAD_LABEL}</Button>
    </div>
  );
};

/**
 * Whether Clerk has failed to load — the single owner of that question for this
 * module.
 *
 * `useClerk()` resolves the same instance context Clerk's own `<ClerkFailed>`
 * reads, and compares the same `status`. It is a hook rather than that
 * component because the page's content needs the NEGATION, which Clerk ships no
 * component for; deriving one half from `<ClerkFailed>` and the other from the
 * status would be two predicates for one question, free to drift.
 */
function useClerkLoadFailed(): boolean {
  return useClerk().status === CLERK_ERROR_STATUS;
}
