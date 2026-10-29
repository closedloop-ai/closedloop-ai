"use client";

import { usePostHog } from "@posthog/next";
import { useEffect, useLayoutEffect } from "react";
import { installAnalyticsUrlRedaction } from "./posthog-url-redaction";

/**
 * `@posthog/next`'s `ClientPostHogProvider` calls `posthog.init` DURING its own
 * render, so by the time any descendant effect runs the client exists. A layout
 * effect is what makes "before the first capture" true rather than likely: it
 * runs at commit, in the same task as the render, while the earliest capture on
 * these surfaces is `PostHogPageView`'s passive effect — and passive effects all
 * run after every layout effect.
 *
 * The same property is what puts the sweep ahead of the FLAGS request, the one
 * sink `before_send` cannot reach: `_callFlagsEndpoint` is reached only through
 * `reloadFeatureFlags`'s `setTimeout(…, 5)` debounce, and it reads
 * `persistence.get_initial_props()` when that macrotask fires rather than when
 * it was scheduled. Downgrading this to a passive effect would still beat the
 * timer, but relying on the timer instead of the commit is what would make it
 * luck; the regression that pins it is `posthog-url-redaction.test.tsx`,
 * "sweeps the store before the flags endpoint can build its payload".
 */
const useRedactionInstallEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

/**
 * Installs the function-shaped url redaction posthog-js's init options cannot
 * carry across the Server-to-Client boundary. Renders nothing.
 *
 * See `./posthog-url-redaction` for what it installs and why each piece cannot
 * live in `POSTHOG_CLIENT_DEFAULTS` instead.
 */
export function PostHogUrlRedactionGuard() {
  const posthog = usePostHog();

  useRedactionInstallEffect(() => {
    if (posthog) {
      installAnalyticsUrlRedaction(posthog);
    }
  }, [posthog]);

  return null;
}
