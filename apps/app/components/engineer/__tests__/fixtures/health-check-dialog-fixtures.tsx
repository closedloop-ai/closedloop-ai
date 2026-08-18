import { HealthCheckRepairAction } from "@closedloop-ai/loops-api/compute-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

export const RE_RECHECK_BUTTON = /re-check/i;
export const RE_RUN_ON_CLOUD_BUTTON = /run on cloud/i;
export const RE_REPAIR_BUTTON = /^repair \d+ failure/i;
/** The class the design-system Button's `default` (primary) variant emits. */
export const PRIMARY_BUTTON_CLASS = "bg-primary";

export const failingData = {
  checks: [{ id: "cli", label: "CLI", required: true, passed: false }],
  allRequiredPassed: false,
};

/** A failing check the gateway annotated as one Repair can actually fix. */
export const repairableFailingData = {
  checks: [
    {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: false,
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ClearBinaryOverride,
      },
    },
  ],
  allRequiredPassed: false,
};

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function createWrapper(queryClient = createTestQueryClient()) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}
