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

/**
 * Next.js control-flow "errors" — `notFound()` and `redirect()` — throw with a
 * digest prefix rather than representing a real fault. They surface to the app
 * error boundaries but must not be reported as errors (FEA-2404): a 404 on a
 * deleted artifact is expected UX, not an incident. RUM's own `beforeSend`
 * filter also drops the SDK-captured path; this is the explicit-report guard.
 */
const NEXTJS_CONTROL_FLOW_DIGEST_PREFIXES = [
  "NEXT_HTTP_ERROR_FALLBACK;",
  "NEXT_REDIRECT",
] as const;

function isNextjsControlFlowDigest(digest: string | undefined): boolean {
  if (!digest) {
    return false;
  }
  return NEXTJS_CONTROL_FLOW_DIGEST_PREFIXES.some((prefix) =>
    digest.startsWith(prefix)
  );
}

export function reportNextjsError(
  error: Error & { digest?: string },
  context: DatadogRumErrorContext
): void {
  if (isNextjsControlFlowDigest(error.digest)) {
    return;
  }

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
