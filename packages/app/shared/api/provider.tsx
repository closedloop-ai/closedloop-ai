"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { ApiAdapter } from "./api-adapter";

const ApiAdapterContext = createContext<ApiAdapter | null>(null);

export function ApiAdapterProvider({
  adapter,
  children,
}: {
  adapter: ApiAdapter;
  children?: ReactNode;
}) {
  return (
    <ApiAdapterContext.Provider value={adapter}>
      {children}
    </ApiAdapterContext.Provider>
  );
}

/**
 * Internal accessor used by `useApiClient`. Not intended for direct use by
 * feature code.
 */
export function useApiAdapter(): ApiAdapter {
  const adapter = useContext(ApiAdapterContext);
  if (adapter) {
    return adapter;
  }
  throw new Error(
    "useApiClient requires an <ApiAdapterProvider> ancestor. Mount one at the app root with a surface adapter (web: webApiAdapter in apps/app)."
  );
}

/**
 * Non-throwing counterpart to {@link useApiAdapter}: the mounted adapter, or
 * `null` where no `<ApiAdapterProvider>` is an ancestor.
 *
 * For SHARED machinery that must degrade rather than crash a subtree at a mount
 * site with no API port — Storybook, mini-table tests, the persisted-view unit
 * suites — mirroring `useOptionalAuthAdapter` in `shared/auth/provider`. A
 * feature that genuinely needs the API keeps using {@link useApiAdapter}, whose
 * throw is the correct answer there.
 */
export function useApiAdapterOptional(): ApiAdapter | null {
  return useContext(ApiAdapterContext);
}
