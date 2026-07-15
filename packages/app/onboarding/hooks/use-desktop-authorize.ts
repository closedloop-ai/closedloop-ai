"use client";

import {
  type DesktopAuthorizeMintRequest,
  type DesktopAuthorizeMintResult,
  desktopAuthorizeMintResultSchema,
} from "@repo/api/src/types/desktop-authorize";
import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

export type {
  DesktopAuthorizeMintRequest,
  DesktopAuthorizeMintResult,
} from "@repo/api/src/types/desktop-authorize";

/**
 * Mints a one-time desktop authorization code for the consenting user.
 *
 * Desktop routes return a raw body (no `ApiResult` envelope), so this uses
 * `postRaw` — `post` would unwrap a non-existent `.data` and yield `undefined`.
 * The raw JSON is then validated through {@link desktopAuthorizeMintResultSchema}
 * so a malformed 2xx rejects the mutation (rendering an error) instead of
 * handing the desktop a hand-off URL with an undefined `code`.
 *
 * The consent page renders its own feedback for every error path, so the shared
 * default-error toast is suppressed.
 */
export function useDesktopAuthorizeMint() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async (
      input: DesktopAuthorizeMintRequest
    ): Promise<DesktopAuthorizeMintResult> => {
      const raw = await apiClient.postRaw<unknown>("/desktop/authorize", input);
      return desktopAuthorizeMintResultSchema.parse(raw);
    },
    meta: { suppressDefaultErrorToast: true },
    retry: 0,
  });
}
