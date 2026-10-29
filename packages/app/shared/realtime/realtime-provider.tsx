"use client";

import type { RealtimeClientPort } from "@repo/realtime-client/port";
import { createContext, type ReactNode, useContext } from "react";

const RealtimeClientContext = createContext<RealtimeClientPort | null>(null);

/**
 * PLN-2106 step 6. Hosts the realtime client for the bindings below it: the
 * socket.io client on web, an IPC-backed port in the desktop renderer.
 */
export function RealtimeProvider({
  client,
  children,
}: {
  /** Null mounts no client while keeping the tree below in place. */
  client: RealtimeClientPort | null;
  children: ReactNode;
}) {
  return (
    <RealtimeClientContext.Provider value={client}>
      {children}
    </RealtimeClientContext.Provider>
  );
}

/** The hosted client, or null where none is mounted (Storybook, desktop Local mode). */
export function useRealtimeClient(): RealtimeClientPort | null {
  return useContext(RealtimeClientContext);
}
