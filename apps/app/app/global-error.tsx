"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { fonts } from "@repo/design-system/lib/fonts";
import { useEffect } from "react";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";
import { toReportableError } from "@/lib/datadog-rum/thrown-value";
import {
  GLOBAL_ERROR_HEADING,
  GLOBAL_ERROR_RETRY_LABEL,
} from "@/lib/global-error-copy";

// `unknown` for the reason `app/error.tsx` states: Next types the thrown value
// that way, and this boundary replaces the root layout, so a crash here is the
// whole document (ISS-6995).
//
// `retry`, not `reset` (ISS-11423): a server-side root-layout failure arrives
// inside the RSC payload, so `reset()` re-renders that payload and re-throws.
// Next 16.3.3's `retry()` refreshes the payload first, then resets.
type GlobalErrorProperties = {
  readonly error: unknown;
  readonly retry: () => void;
};

const GlobalError = ({ error, retry }: GlobalErrorProperties) => {
  useEffect(() => {
    const reportable = toReportableError(error);
    reportNextjsError(reportable, {
      digest: reportable.digest,
      source: RumErrorSource.GlobalError,
    });
  }, [error]);

  return (
    <html className={fonts} lang="en">
      <body>
        <h1>{GLOBAL_ERROR_HEADING}</h1>
        <Button onClick={() => retry()}>{GLOBAL_ERROR_RETRY_LABEL}</Button>
      </body>
    </html>
  );
};

export default GlobalError;
