"use client";

import type {
  DesktopProvisioningAttempt,
  DesktopProvisioningCapability,
  DesktopProvisioningPlatform,
} from "@repo/api/src/types/electron";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { getClientDesktopProvisioningPlatform } from "@/lib/desktop-provisioning-platform";

export const desktopProvisioningKeys = {
  all: ["desktop-provisioning"] as const,
  capability: (platform: DesktopProvisioningPlatform) =>
    [...desktopProvisioningKeys.all, "capability", platform] as const,
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
