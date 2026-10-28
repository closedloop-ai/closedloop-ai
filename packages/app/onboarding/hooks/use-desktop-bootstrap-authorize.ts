"use client";

import {
  type DesktopBootstrapMintRequest,
  type DesktopBootstrapMintResult,
  desktopBootstrapMintResultSchema,
} from "@repo/api/src/types/desktop-bootstrap";
import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Mints the device-bound one-time code for a pending Clerk principal that has
 * authenticated but has not created an organization yet.
 */
export function useDesktopBootstrapAuthorize() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async (
      input: DesktopBootstrapMintRequest
    ): Promise<DesktopBootstrapMintResult> => {
      const raw = await apiClient.postRaw<unknown>(
        "/desktop/bootstrap-authorize",
        input
      );
      return desktopBootstrapMintResultSchema.parse(raw);
    },
    meta: { suppressDefaultErrorToast: true },
    retry: 0,
  });
}
