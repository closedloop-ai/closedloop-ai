"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useState } from "react";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";

const VALIDATION_ERROR_MESSAGE = "rum-validation-stage-client-render";
const RUM_VALIDATION_ROUTE = "/rum-validation";

export function RumValidationTrigger() {
  const [reported, setReported] = useState(false);

  if (reported) {
    return <h2 className="font-semibold text-lg">Something went wrong</h2>;
  }

  return (
    <Button
      onClick={() => {
        reportNextjsError(new Error(VALIDATION_ERROR_MESSAGE), {
          routeTemplate: RUM_VALIDATION_ROUTE,
          source: "rum-validation",
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
