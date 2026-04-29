"use client";

import type {
  DesktopProvisioningAttempt,
  DesktopProvisioningAttemptStatusResponse,
  DesktopProvisioningCapability,
  DesktopProvisioningPlatform,
  DesktopProvisioningReadinessResponse,
} from "@repo/api/src/types/electron";
import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { getClientDesktopProvisioningPlatform } from "@/lib/desktop-provisioning-platform";

export const desktopProvisioningKeys = {
  all: ["desktop-provisioning"] as const,
  capability: (platform: DesktopProvisioningPlatform) =>
    [...desktopProvisioningKeys.all, "capability", platform] as const,
  status: (onboardingAttemptId: string) =>
    [...desktopProvisioningKeys.all, "status", onboardingAttemptId] as const,
  readiness: () => [...desktopProvisioningKeys.all, "readiness"] as const,
};

export function useDesktopProvisioningCapability() {
  const apiClient = useApiClient();
  const platform = getClientDesktopProvisioningPlatform();

  return useQuery({
    queryKey: desktopProvisioningKeys.capability(platform),
    queryFn: () =>
      apiClient.get<DesktopProvisioningCapability>(
        `/desktop/provisioning-capability?platform=${encodeURIComponent(platform)}`
      ),
    staleTime: 60_000,
  });
}

export function useCreateDesktopProvisioningAttempt() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: {
      webAppOrigin: string;
      platform: DesktopProvisioningPlatform;
    }) =>
      apiClient.post<DesktopProvisioningAttempt>(
        "/desktop/provisioning-attempt",
        input
      ),
  });
}

export function useDesktopProvisioningAttemptStatus(
  onboardingAttemptId: string | null
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: desktopProvisioningKeys.status(onboardingAttemptId ?? ""),
    queryFn: () =>
      apiClient.get<DesktopProvisioningAttemptStatusResponse>(
        `/desktop/provisioning-attempt/${encodeURIComponent(
          onboardingAttemptId ?? ""
        )}`
      ),
    enabled: onboardingAttemptId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === DesktopProvisioningAttemptStatus.Complete ||
      query.state.data?.status === DesktopProvisioningAttemptStatus.Expired
        ? false
        : 5000,
  });
}

export function useDesktopProvisioningReadiness() {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: desktopProvisioningKeys.readiness(),
    queryFn: () =>
      apiClient.get<DesktopProvisioningReadinessResponse>(
        "/desktop/provisioning-readiness"
      ),
    refetchInterval: (query) =>
      query.state.data?.status === DesktopProvisioningReadinessStatus.Complete
        ? false
        : 10_000,
  });
}
