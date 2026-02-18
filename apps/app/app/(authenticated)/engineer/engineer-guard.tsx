"use client";

import { AlertCircle } from "lucide-react";
import { EngineerDashboard } from "@/components/engineer/engineer-dashboard";
import { appEnvironment } from "@/lib/environment";

/**
 * Guards the engineer view to only be accessible on localhost.
 * closedloop-dev features require spawning local processes (Claude CLI, git, etc.)
 * which are only possible when running locally.
 */
export function EngineerGuard() {
  if (appEnvironment !== "local") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <div className="max-w-md space-y-4 text-center">
          <AlertCircle className="mx-auto size-12 text-muted-foreground" />
          <h2 className="font-semibold text-xl">Engineer View Not Available</h2>
          <p className="text-muted-foreground">
            The Engineer View is only available when running on localhost. It
            requires access to local CLI tools (Claude, git, etc.) to function.
          </p>
          <p className="text-muted-foreground text-sm">
            Run{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
              pnpm dev:engineer
            </code>{" "}
            locally to use this feature.
          </p>
        </div>
      </div>
    );
  }

  return <EngineerDashboard />;
}
