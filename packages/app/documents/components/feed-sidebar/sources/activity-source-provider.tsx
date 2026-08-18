"use client";

import { createContext, type ReactNode, useContext } from "react";

export type ActivitySourceContextValue = {
  /**
   * The artifact whose activity timeline the source reads. Threaded through a
   * context (rather than the generic `FeedSidebar` prop surface) so the source's
   * `useItems` / `renderItem` can reach it without widening the adapter API —
   * mirrors `LiveblocksSourceProvider`.
   */
  documentId: string;
};

const ActivitySourceContext = createContext<ActivitySourceContextValue | null>(
  null
);

export function ActivitySourceProvider({
  value,
  children,
}: Readonly<{ value: ActivitySourceContextValue; children: ReactNode }>) {
  return (
    <ActivitySourceContext.Provider value={value}>
      {children}
    </ActivitySourceContext.Provider>
  );
}

export function useActivitySourceContext(): ActivitySourceContextValue {
  const value = useContext(ActivitySourceContext);
  if (value === null) {
    throw new Error(
      "useActivitySourceContext must be used within an ActivitySourceProvider"
    );
  }
  return value;
}
