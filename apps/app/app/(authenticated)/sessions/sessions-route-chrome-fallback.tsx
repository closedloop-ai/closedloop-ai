"use client";

import type { BreadcrumbEntry } from "@/app/(authenticated)/components/header";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";

type SessionsRouteChromeFallbackProps = {
  /**
   * Breadcrumb trail for the route's Header. Sessions list routes pass a single
   * "Sessions" crumb; the detail routes pass the "Sessions" ancestor crumb plus
   * a generic leaf, since the session name is not loaded yet during this window.
   */
  readonly breadcrumbs: BreadcrumbEntry[];
};

/**
 * FEA-4228: the chrome a gated Sessions route renders while its PostHog flag is
 * still resolving.
 *
 * ISS-5001 lifted the shape into the shared {@link RouteChromeFallback} so every
 * gated route's loading moment reads identically; this stays as the Sessions
 * routes' named entry point.
 */
export function SessionsRouteChromeFallback({
  breadcrumbs,
}: SessionsRouteChromeFallbackProps) {
  return <RouteChromeFallback breadcrumbs={breadcrumbs} />;
}
