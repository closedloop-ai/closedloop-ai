"use client";

import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";

type RouteChromeFallbackProps = {
  /**
   * Breadcrumb trail for the route's Header. List routes pass a single crumb;
   * detail routes pass the ancestor crumb plus a generic leaf, since the record
   * name is not loaded yet during this window.
   */
  readonly breadcrumbs: BreadcrumbEntry[];
};

/**
 * The chrome a gated route renders while its PostHog flag is still resolving
 * (FEA-4228, generalized in ISS-5001).
 *
 * `FeatureFlagRouteGate` shows this in place of a blank content region, so the
 * route opens with its Header shell and a skeleton body already in place instead
 * of popping the whole page — breadcrumb and all — in at once when the flag
 * lands. Every gated route whose loaded page renders a `Header` should pass one
 * of these as its `pending`, so the same loading moment reads the same across
 * routes instead of each one inventing its own geometry.
 *
 * The skeleton bars are decorative loading placeholders, so they carry
 * `aria-hidden`; the Header supplies the accessible landmark.
 */
export function RouteChromeFallback({ breadcrumbs }: RouteChromeFallbackProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={breadcrumbs} />
      <div aria-hidden className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}
