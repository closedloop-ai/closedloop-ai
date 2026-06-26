"use client";

import { Loader2Icon } from "lucide-react";

/**
 * Full-viewport loading state for App Router `loading.tsx` segments.
 */
export function PageLoadingSpinner() {
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
