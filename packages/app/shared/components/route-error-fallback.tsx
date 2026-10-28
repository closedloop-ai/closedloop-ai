"use client";

import { Button } from "@repo/design-system/components/ui/button";

type RouteErrorFallbackProps = {
  onRetry: () => void;
};

/**
 * The failed-route screen, shared by the web `app/error.tsx` boundary and the
 * Desktop detail-route boundary. Reporting stays with each host's boundary.
 */
export function RouteErrorFallback({
  onRetry,
}: Readonly<RouteErrorFallbackProps>) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-semibold text-lg">Something went wrong</h1>
      <Button onClick={() => onRetry()}>Try again</Button>
    </div>
  );
}
