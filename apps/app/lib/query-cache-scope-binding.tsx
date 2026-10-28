"use client";

import {
  queryCacheScopeOf,
  useQueryCacheScope,
} from "@repo/app/shared/query/query-cache-scope";
import { useAuth } from "@repo/auth/client";

/**
 * Binds the web shell's `QueryClient` to the signed-in identity (ISS-7442).
 *
 * Renders nothing. It exists as its own element in the root layout because the
 * scope has to be set from a render that happens ABOVE every query and BELOW
 * both `QueryProvider` and Clerk's `AuthProvider` — the layout is the only place
 * all three hold. Kept out of `AppCoreAdapterProvider` so that provider does not
 * acquire a hard dependency on a mounted `QueryClient` it otherwise has no use
 * for.
 */
export function QueryCacheScopeBinding() {
  const { userId, orgId } = useAuth();
  useQueryCacheScope(queryCacheScopeOf(userId, orgId));
  return null;
}
