"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export type DesktopDeviceSessionDetails = {
  userCode: string;
  machineName: string;
  platform: string;
  webAppOrigin: string;
  status: string;
  expiresAt: string;
};

type DesktopDeviceSessionActionInput = {
  userCode: string;
  action: "approve" | "deny";
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
      apiClient.postRaw<DesktopDeviceSessionDetails>(
        "/desktop/device-onboarding/approve",
        { userCode, action }
      ),
    onSuccess: (details, variables) => {
      queryClient.setQueryData(
        desktopOnboardingKeys.session(variables.userCode),
        details
      );
    },
    retry: 0,
  });
}
