"use client";

import type {
  DesktopProvisioningAttempt,
  DesktopProvisioningAttemptStatusResponse,
  DesktopProvisioningCapability,
  DesktopProvisioningReadinessResponse,
} from "@repo/api/src/types/electron";
import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningPlatform,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { getClientDesktopProvisioningPlatform } from "@/lib/desktop-provisioning-platform";

const DESKTOP_PROVISIONING_ATTEMPT_POLL_INTERVAL_MS = 5000;
const DESKTOP_PROVISIONING_READINESS_POLL_INTERVAL_MS = 10_000;

type QueryStatus = "pending" | "error" | "success";

type RefetchQueryState<TData> = {
  readonly state: {
    readonly status: QueryStatus;
    readonly data?: TData;
  };
};

export const desktopProvisioningKeys = {
  all: ["desktop-provisioning"] as const,
  capability: (platform: DesktopProvisioningPlatform) =>
    [...desktopProvisioningKeys.all, "capability", platform] as const,
  status: (onboardingAttemptId: string) =>
    [...desktopProvisioningKeys.all, "status", onboardingAttemptId] as const,
  readiness: () => [...desktopProvisioningKeys.all, "readiness"] as const,
};

export function useDesktopProvisioningCapability(
  platform = getClientDesktopProvisioningPlatform()
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: desktopProvisioningKeys.capability(platform),
    queryFn: () =>
      apiClient.get<DesktopProvisioningCapability>(
        `/desktop/provisioning-capability?platform=${encodeURIComponent(platform)}`
      ),
    enabled: platform !== DesktopProvisioningPlatform.Unknown,
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
    refetchInterval: getDesktopProvisioningAttemptRefetchInterval,
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
    refetchInterval: getDesktopProvisioningReadinessRefetchInterval,
  });
}

/**
 * Returns the polling interval for attempt status requests.
 * Stops on request errors and every terminal attempt state.
 */
export function getDesktopProvisioningAttemptRefetchInterval(
  query: RefetchQueryState<DesktopProvisioningAttemptStatusResponse>
): false | number {
  if (query.state.status === "error") {
    return false;
  }

  switch (query.state.data?.status) {
    case DesktopProvisioningAttemptStatus.Claimed:
    case DesktopProvisioningAttemptStatus.Complete:
    case DesktopProvisioningAttemptStatus.Expired:
      return false;
    default:
      return DESKTOP_PROVISIONING_ATTEMPT_POLL_INTERVAL_MS;
  }
}

/**
 * Returns the polling interval for account-level Desktop readiness requests.
 * Stops once readiness is complete or the request itself fails.
 */
export function getDesktopProvisioningReadinessRefetchInterval(
  query: RefetchQueryState<DesktopProvisioningReadinessResponse>
): false | number {
  if (
    query.state.status === "error" ||
    query.state.data?.status === DesktopProvisioningReadinessStatus.Complete
  ) {
    return false;
  }

  return DESKTOP_PROVISIONING_READINESS_POLL_INTERVAL_MS;
}
