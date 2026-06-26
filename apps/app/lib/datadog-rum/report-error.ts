"use client";

import { addNextjsError } from "@datadog/browser-rum-nextjs";

type RumErrorSource =
  | "global-error"
  | "nextjs-error-boundary"
  | "rum-validation";

export type DatadogRumErrorContext = {
  digest?: string;
  routeTemplate?: string;
  source: RumErrorSource;
};

type ErrorWithDatadogContext = Error & {
  dd_context?: DatadogRumErrorContext;
  digest?: string;
};

export function reportNextjsError(
  error: Error & { digest?: string },
  context: DatadogRumErrorContext
): void {
  const errorWithContext: ErrorWithDatadogContext = new Error(error.message);
  errorWithContext.name = error.name;
  errorWithContext.stack = error.stack;
  errorWithContext.digest = error.digest;
  errorWithContext.dd_context = sanitizeContext(error, context);
  addNextjsError(errorWithContext);
}

export function sanitizeContext(
  error: Error & { digest?: string },
  context: DatadogRumErrorContext
): DatadogRumErrorContext {
  return {
    ...(context.digest || error.digest
      ? { digest: context.digest ?? error.digest }
      : {}),
    ...(context.routeTemplate ? { routeTemplate: context.routeTemplate } : {}),
    source: context.source,
  };
}
