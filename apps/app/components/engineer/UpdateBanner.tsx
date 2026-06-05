"use client";

import { ArrowDownToLine, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useUpdateChecker } from "@/hooks/engineer/useUpdateChecker";

export function UpdateBanner() {
  const {
    isUpdateAvailable,
    behindBy,
    dismissed,
    pulling,
    dismiss,
    pullUpdate,
  } = useUpdateChecker();

  if (!isUpdateAvailable || dismissed) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-primary px-4 py-2 text-primary-foreground text-sm">
      <ArrowDownToLine className="size-3.5 shrink-0" />
      <span>
        A new version is available{" "}
        <span className="opacity-75">
          ({behindBy} commit{behindBy === 1 ? "" : "s"} behind)
        </span>
      </span>
      <button
        className="ml-1 cursor-pointer rounded-md bg-primary-foreground/20 px-2.5 py-0.5 font-medium text-xs transition-colors hover:bg-primary-foreground/30 disabled:opacity-50"
        disabled={pulling}
        onClick={async () => {
          dismiss();
          const result = await pullUpdate();
          if (result.ok) {
            toast.success("Updated to latest version");
          } else {
            let message = result.error || "Failed to pull latest changes";
            if (result.error?.includes("unstaged changes")) {
              message = "Commit or stash your changes before updating";
            } else if (result.error?.includes("merge conflict")) {
              message = "Merge conflicts detected — resolve them manually";
            }
            toast.error(message);
          }
        }}
      >
        {pulling ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            Updating…
          </span>
        ) : (
          "Update now"
        )}
      </button>
      <button
        aria-label="Dismiss"
        className="ml-auto cursor-pointer rounded p-0.5 transition-colors hover:bg-primary-foreground/20"
        onClick={dismiss}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
