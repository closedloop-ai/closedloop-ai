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
