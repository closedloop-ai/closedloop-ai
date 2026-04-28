"use client";

import { useAuth } from "@repo/auth/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resolveApiUrl } from "@/hooks/use-api-client";

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

async function fetchDesktopOnboarding<T>(
  token: string | null,
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${resolveApiUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof body?.code === "string"
        ? body.code
        : "DESKTOP_DEVICE_SESSION_FAILED"
    );
  }
  return body as T;
}

/** Loads the browser approval details for a Desktop-first onboarding code. */
export function useDesktopDeviceSession(userCode: string) {
  const { getToken } = useAuth();

  return useQuery({
    queryKey: desktopOnboardingKeys.session(userCode),
    queryFn: async () => {
      const token = await getToken();
      return fetchDesktopOnboarding<DesktopDeviceSessionDetails>(
        token,
        `/desktop/device-onboarding/session?code=${encodeURIComponent(
          userCode
        )}`
      );
    },
    enabled: userCode.length > 0,
    retry: 0,
  });
}

/** Approves or denies a pending Desktop-first onboarding request. */
export function useDesktopDeviceSessionAction() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      userCode,
      action,
    }: DesktopDeviceSessionActionInput) => {
      const token = await getToken();
      return fetchDesktopOnboarding<DesktopDeviceSessionDetails>(
        token,
        "/desktop/device-onboarding/approve",
        {
          method: "POST",
          body: JSON.stringify({ userCode, action }),
        }
      );
    },
    onSuccess: (details, variables) => {
      queryClient.setQueryData(
        desktopOnboardingKeys.session(variables.userCode),
        details
      );
    },
    retry: 0,
  });
}
