"use client";

import { Loader2Icon } from "lucide-react";

export function TableLoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function TableErrorState({ error }: { error: Error }) {
  return (
    <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
      {error.message}
    </div>
  );
}
