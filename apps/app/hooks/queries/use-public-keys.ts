"use client";

import type { UserPublicKeySummary } from "@repo/api/src/types/compute-target";
import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import {
  deleteBrowserSigningKey,
  getOrCreateBrowserSigningKey,
} from "@/lib/desktop-command-signing/key-store";

/**
 * Registers this browser's command-signing public key with the current org.
 * The browser-held Ed25519 private key remains non-exportable in IndexedDB.
 */
export function useRegisterBrowserCommandKey() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async () => {
      const key = await getOrCreateBrowserSigningKey();
      if (!key.ok) {
        throw new Error(`Command signing key unavailable: ${key.reason}`);
      }
      return apiClient.post<UserPublicKeySummary>("/public-keys", {
        publicKeyBase64: key.publicKeyBase64,
        fingerprint: key.fingerprint,
      });
    },
  });
}

/**
 * Unregisters this browser's command-signing public key and clears the local
 * non-exportable keypair so a later registration starts with a fresh key.
 */
export function useUnregisterBrowserCommandKey() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async (fingerprint: string) => {
      const result = await apiClient.delete<{ deleted: boolean }>(
        `/public-keys?fingerprint=${encodeURIComponent(fingerprint)}`
      );
      const deleted = await deleteBrowserSigningKey();
      if (!deleted.ok) {
        throw new Error(
          `Browser signing key could not be cleared: ${deleted.reason}`
        );
      }
      return result;
    },
  });
}
