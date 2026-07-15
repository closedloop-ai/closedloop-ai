"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import type { DesktopDeviceSessionDetails } from "../types";

export type { DesktopDeviceSessionDetails } from "../types";

type DesktopDeviceSessionActionInput = {
  userCode: string;
  action: "approve" | "deny";
};

/**
 * Exact body returned by `POST /desktop/device-onboarding/approve`. The route
 * intentionally echoes only these four fields — NOT the full session detail —
 * so the result is typed honestly here rather than as
 * `DesktopDeviceSessionDetails`. The approval UI derives its terminal state
 * from the action outcome and refetches the detail, so the partial body is
 * never written into the session cache.
 */
export type DesktopDeviceSessionActionResult = {
  status: string;
  machineName: string;
  platform: string;
  webAppOrigin: string;
};

export const desktopOnboardingKeys = {
  all: ["desktop-onboarding"] as const,
  session: (code: string) =>
    [...desktopOnboardingKeys.all, "session", code] as const,
};

/** Loads the browser approval details for a Desktop-first onboarding code. */
export function useDesktopDeviceSession(userCode: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: desktopOnboardingKeys.session(userCode),
    queryFn: () =>
      apiClient.getRaw<DesktopDeviceSessionDetails>(
        `/desktop/device-onboarding/session?code=${encodeURIComponent(
          userCode
        )}`
      ),
    enabled: userCode.length > 0,
    retry: 0,
  });
}

/** Approves or denies a pending Desktop-first onboarding request. */
export function useDesktopDeviceSessionAction() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userCode, action }: DesktopDeviceSessionActionInput) =>
      apiClient.postRaw<DesktopDeviceSessionActionResult>(
        "/desktop/device-onboarding/approve",
        { userCode, action }
      ),
    // The approval page renders feedback for every error path itself (typed
    // failure states + a toast for transient errors), so suppress the shared
    // default-error toast to avoid double feedback.
    meta: { suppressDefaultErrorToast: true },
    onSuccess: (_result, variables) => {
      // Refetch the full detail instead of writing the partial action result
      // into the session cache.
      queryClient.invalidateQueries({
        queryKey: desktopOnboardingKeys.session(variables.userCode),
      });
    },
    retry: 0,
  });
}
