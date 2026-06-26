"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useEffect } from "react";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";

type ErrorProperties = {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
};

export default function AppError({ error, reset }: ErrorProperties) {
  useEffect(() => {
    reportNextjsError(error, {
      digest: error.digest,
      source: "nextjs-error-boundary",
    });
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-semibold text-lg">Something went wrong</h1>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
