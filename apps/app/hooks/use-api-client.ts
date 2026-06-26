"use client";

import { resolveApiOrigin } from "@/lib/api-origin";

/**
 * @deprecated Migration seam (FEA-1510): the HTTP client now lives in the
 * shared app-core layer. Import `useApiClient` from
 * `@repo/app/shared/api/use-api-client` in new code. This re-export is
 * removed in PLN-810 Phase 6 once the hooks wave rewrites all importers.
 */
export { useApiClient } from "@repo/app/shared/api/use-api-client";

export function resolveApiUrl(): string {
  return resolveApiOrigin();
}
