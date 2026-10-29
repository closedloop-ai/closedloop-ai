"use client";

import { RouteErrorFallback } from "@repo/app/shared/components/route-error-fallback";
import { useEffect } from "react";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";
import { toReportableError } from "@/lib/datadog-rum/thrown-value";

// `unknown`, because that is what Next actually hands a boundary
// (`ErrorInfo.error`) — a `throw "string"` or `throw null` reaches here, and
// this is the last boundary the authenticated app has (ISS-6995).
type ErrorProperties = {
  readonly error: unknown;
  readonly reset: () => void;
};

export default function AppError({ error, reset }: ErrorProperties) {
  useEffect(() => {
    const reportable = toReportableError(error);
    reportNextjsError(reportable, {
      digest: reportable.digest,
      source: RumErrorSource.NextjsErrorBoundary,
    });
  }, [error]);

  return <RouteErrorFallback onRetry={reset} />;
}
