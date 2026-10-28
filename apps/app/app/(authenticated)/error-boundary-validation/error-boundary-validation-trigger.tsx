"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useState } from "react";

const ERROR_THROW = "error";
const NON_ERROR_THROW = "non-error";
const NULL_THROW = "null";

type PendingThrow =
  | typeof ERROR_THROW
  | typeof NON_ERROR_THROW
  | typeof NULL_THROW
  | null;

const VALIDATION_ERROR_MESSAGE = "error-boundary-validation-render";
const VALIDATION_NON_ERROR_VALUE = "error-boundary-validation-non-error";

/**
 * Throws during RENDER, not in the click handler: only a render failure
 * propagates to the route's error boundary, which is the thing under test
 * (ISS-6996).
 *
 * Two of the three controls throw values Next types as `unknown` and the
 * boundaries now narrow (ISS-6995), and they are NOT interchangeable. A string
 * only shows that a non-`Error` renders recovery UI — reading `.digest` off it
 * yields `undefined`, which the unfixed boundary survived too. `null` is the
 * value that actually crashed inside the crash handler, so it is the one whose
 * e2e distinguishes the fixed boundary from the unfixed one.
 */
export function ErrorBoundaryValidationTrigger() {
  const [pending, setPending] = useState<PendingThrow>(null);

  if (pending === ERROR_THROW) {
    throw new Error(VALIDATION_ERROR_MESSAGE);
  }
  if (pending === NON_ERROR_THROW) {
    throw VALIDATION_NON_ERROR_VALUE;
  }
  if (pending === NULL_THROW) {
    // biome-ignore lint/style/useThrowOnlyError: throwing null IS the production shape under test — it is the value that crashed the pre-fix boundary (ISS-6995).
    throw null;
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button onClick={() => setPending(ERROR_THROW)} type="button">
        Trigger boundary error
      </Button>
      <Button
        onClick={() => setPending(NON_ERROR_THROW)}
        type="button"
        variant="outline"
      >
        Trigger non-Error throw
      </Button>
      <Button
        onClick={() => setPending(NULL_THROW)}
        type="button"
        variant="outline"
      >
        Trigger null throw
      </Button>
    </div>
  );
}

export { VALIDATION_ERROR_MESSAGE, VALIDATION_NON_ERROR_VALUE };
