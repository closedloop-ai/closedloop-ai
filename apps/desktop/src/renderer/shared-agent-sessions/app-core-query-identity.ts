import { queryCacheScopeOf } from "@repo/app/shared/query/query-cache-scope";
import { setQueryCacheScope } from "@repo/app/shared/query/query-client";
import type { QueryClient } from "@tanstack/react-query";
import { useRef } from "react";

/**
 * Binds the app-core `QueryClient` to the signed-in identity, during render.
 *
 * The client is rebuilt only when the MODE changes, and a direct authenticated
 * identity change (another user or organization, still online) keeps the mode,
 * so the client and everything it cached survive it. Nearly every key factory
 * is identity-agnostic (`customFieldKeys.list({})`, the `"http"`-scoped session
 * keys), so the next identity's reads were cache hits on the previous one's
 * rows (ISS-12302 review). This is the web shell's boundary on this client: the
 * identity folded into every query hash (ISS-7442, `QueryCacheScopeBinding`),
 * and a clear when a resolved identity leaves the same client, as
 * `DesktopBranchesConsumptionProvider` clears the Branch client.
 *
 * Call it from a component that renders above every query on `queryClient`, so
 * no read below it hashes against the departed identity.
 */
export function useAppCoreQueryIdentity(
  queryClient: QueryClient,
  userId: string | null,
  organizationId: string | null
): void {
  const scope = queryCacheScopeOf(userId, organizationId);
  const bound = useRef<{
    queryClient: QueryClient;
    scope: string | null;
  } | null>(null);
  const previous = bound.current;
  if (
    previous?.queryClient === queryClient &&
    previous.scope !== null &&
    previous.scope !== scope
  ) {
    queryClient.clear();
  }
  bound.current = { queryClient, scope };
  setQueryCacheScope(queryClient, scope);
}
