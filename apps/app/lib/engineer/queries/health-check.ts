import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./keys";

export type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
};

export type HealthCheckResponse = {
  checks: CheckResult[];
  allRequiredPassed: boolean;
};

export function healthCheckOptions() {
  return queryOptions<HealthCheckResponse>({
    queryKey: queryKeys.healthCheck(),
    queryFn: async () => {
      const res = await fetch("/api/engineer/health-check");
      return res.json();
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
