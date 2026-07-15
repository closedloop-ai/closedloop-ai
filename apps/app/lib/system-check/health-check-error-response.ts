import type {
  CheckResult,
  HealthCheckResponse,
} from "@repo/api/src/types/compute-target";

/** Builds a terminal health-check response for UI surfaces when the gateway query fails. */
export function buildHealthCheckErrorResponse(
  error: unknown
): HealthCheckResponse {
  const check: CheckResult = {
    id: "health-check-request",
    label: "System Check",
    required: true,
    passed: false,
    error: getHealthCheckErrorMessage(error),
    remediation:
      "Retry System Check. If this persists, update Closedloop plugins manually and try again.",
  };

  return {
    checks: [check],
    allRequiredPassed: false,
  };
}

function getHealthCheckErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "System check timed out";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "System check timed out";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "System check was cancelled";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "System check failed";
}
