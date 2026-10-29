"use client";

import { datadogRum } from "@datadog/browser-rum";
import { Button } from "@repo/design-system/components/ui/button";
import { useState } from "react";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";

const VALIDATION_ERROR_MESSAGE = "rum-validation-stage-client-render";
const RUM_VALIDATION_ROUTE = "/rum-validation";

export function RumValidationTrigger() {
  const [reported, setReported] = useState(false);
  // ISS-12356(f): at sessionSampleRate 42 most sessions never reach the SDK.
  // `getInternalContext()` returns undefined exactly when the browser-rum
  // session manager's `findTrackedSession` found the session sampled out
  // (@datadog/browser-rum-core sessionManager.js), so e2e/rum-validation.spec.ts
  // reads this to tell "sampled out" from "a tracked session that sent
  // nothing" before it decides pass/fail.
  const [sessionTracked, setSessionTracked] = useState<boolean | null>(null);

  if (reported) {
    return (
      <h2
        className="font-semibold text-lg"
        data-rum-session-tracked={
          sessionTracked === null ? "unknown" : String(sessionTracked)
        }
      >
        Something went wrong
      </h2>
    );
  }

  return (
    <Button
      onClick={() => {
        setSessionTracked(
          datadogRum.getInternalContext()?.session_id !== undefined
        );
        reportNextjsError(new Error(VALIDATION_ERROR_MESSAGE), {
          routeTemplate: RUM_VALIDATION_ROUTE,
          source: RumErrorSource.RumValidation,
        });
        setReported(true);
      }}
      type="button"
    >
      Trigger validation error
    </Button>
  );
}

export { VALIDATION_ERROR_MESSAGE };
