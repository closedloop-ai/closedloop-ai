import { RealtimeProvider } from "@repo/app/shared/realtime/realtime-provider";
import { type ReactNode, useEffect, useState } from "react";
import {
  createIpcRealtimePort,
  type IpcRealtimePort,
} from "./ipc-realtime-port";

/**
 * PLN-2162 M4: hosts the renderer's IPC realtime port while `enabled` (Cloud
 * mode). Without it, or under a preload with no realtime bridge, consumers
 * find no client and poll.
 */
export function DesktopRealtimeProvider({
  enabled,
  children,
}: Readonly<{ enabled: boolean; children: ReactNode }>) {
  const [port, setPort] = useState<IpcRealtimePort | null>(null);

  useEffect(() => {
    const api = window.desktopApi.realtime;
    if (!enabled || api === undefined) {
      return;
    }
    const next = createIpcRealtimePort(api);
    setPort(next);
    return () => {
      next.dispose();
      setPort(null);
    };
  }, [enabled]);

  return <RealtimeProvider client={port}>{children}</RealtimeProvider>;
}
