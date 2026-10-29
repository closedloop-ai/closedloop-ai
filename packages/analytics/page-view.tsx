"use client";

import { usePostHog } from "@posthog/next";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { redactedSearchString } from "./redact-query-params";

/**
 * App Router pageview capture (ISS-8173).
 *
 * Replaces `@posthog/next@0.1.0`'s own `PostHogPageView`, which sent
 * `$current_url` as the bare `usePathname()` result. PostHog's ingestion
 * pipeline needs an ABSOLUTE url to map heatmap data onto a page: a relative
 * `/login` still ingests the event but its heatmap data is dropped, and that
 * loss is unrecoverable — only events captured afterwards can carry it.
 *
 * `@posthog/next` ships `capture_pageview: false`, so this is the only source
 * of `$pageview` on the surfaces that mount it; there is no automatic capture
 * behind it to fall back on.
 *
 * The query string is carried (upstream did that too) but its sensitive values
 * are redacted first — see `./redact-query-params`, which also states what that
 * redaction does NOT reach.
 */
export function PostHogPageView() {
  return (
    <Suspense fallback={null}>
      <PageViewTracker />
    </Suspense>
  );
}

function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const posthog = usePostHog();
  // Keyed on the query's contents, not the `searchParams` object: a hash-only
  // navigation hands back a fresh object with the same query, and keying on
  // its identity re-captured the page on every in-page anchor link. The query
  // is still load-bearing — a query-only navigation leaves `pathname` untouched.
  const rawSearch = searchParams.toString();
  const lastPageView = useRef<{
    client: NonNullable<typeof posthog>;
    route: string;
  } | null>(null);

  useEffect(() => {
    if (!posthog) {
      return;
    }
    // Raw route identity keeps query-only navigation observable even when two
    // distinct sensitive values redact to the same outgoing URL. A ref lasts
    // through StrictMode's repeated setup without suppressing back/forward.
    const route = `${pathname}?${rawSearch}`;
    if (
      lastPageView.current?.client === posthog &&
      lastPageView.current.route === route
    ) {
      return;
    }
    const search = redactedSearchString(new URLSearchParams(rawSearch));
    const currentUrl = absolutePageUrl(
      search ? `${pathname}?${search}` : pathname
    );
    if (!currentUrl) {
      return;
    }
    // Recorded before the attempt: one attempt per route, so a failed capture
    // is not retried by a repeated effect, and the next route still counts.
    lastPageView.current = { client: posthog, route };
    try {
      posthog.capture("$pageview", { $current_url: currentUrl });
    } catch (error) {
      // Analytics failure must not interrupt navigation or rendering.
      reportCaptureFailure(error);
    }
  }, [pathname, rawSearch, posthog]);

  return null;
}

/**
 * `undefined` off the browser — there is no origin to prepend during SSR, and a
 * relative url is the exact shape PostHog discards, so the capture is skipped
 * rather than sent in a shape whose heatmap data is thrown away.
 */
function absolutePageUrl(path: string): string | undefined {
  if (globalThis.window === undefined) {
    return undefined;
  }
  return `${globalThis.window.location.origin}${path}`;
}

/**
 * Hands a capture failure to the window's error listeners (RUM, error
 * monitoring) without throwing into render. Browsers without `reportError`
 * get the same listeners through an uncaught error on a later task.
 */
function reportCaptureFailure(error: unknown): void {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
    return;
  }
  setTimeout(() => {
    throw error;
  });
}
