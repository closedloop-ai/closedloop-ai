"use client";

import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import {
  createLazyRealtimePort,
  type LazyRealtimePort,
} from "@repo/app/shared/realtime/lazy-realtime-port";
import { RealtimeProvider } from "@repo/app/shared/realtime/realtime-provider";
import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
  type SocketIoRealtimeClientOptions,
} from "@repo/realtime-client/connection";
import {
  issuedRealtimeTokenSchema,
  REALTIME_TOKEN_PATH,
} from "@repo/realtime-contract/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { getDatadogRumVersion } from "@/lib/datadog-rum/config";

export type CreateWebRealtimeClient = (
  options: SocketIoRealtimeClientOptions
) => RealtimeClient;

/**
 * PLN-2162 M3 (decision 9): hosts the realtime client for a signed-in user,
 * one per (user, org), so a sign-out or an org switch closes it. The socket
 * opens on the first join. The service URL comes from the token, and a token
 * the API refuses (a 503 until ISS-11210 lands) leaves every channel not live,
 * so its listeners keep polling.
 */
export function WebRealtimeHost({
  children,
  createClient = createSocketIoRealtimeClient,
}: Readonly<{
  children: ReactNode;
  createClient?: CreateWebRealtimeClient;
}>) {
  const { userId, orgId } = useAuthSnapshot();
  const apiClient = useApiClient();
  const latestApiClient = useRef(apiClient);
  useEffect(() => {
    latestApiClient.current = apiClient;
  });
  const [port, setPort] = useState<LazyRealtimePort | null>(null);

  useEffect(() => {
    if (userId === null || orgId === null) {
      return;
    }
    const next = createLazyRealtimePort(() =>
      createClient({
        clientVersion: getDatadogRumVersion(),
        getToken: async () =>
          issuedRealtimeTokenSchema.parse(
            await latestApiClient.current.post<unknown>(REALTIME_TOKEN_PATH, {})
          ),
      })
    );
    setPort(next);
    return () => {
      next.close();
      setPort(null);
    };
  }, [userId, orgId, createClient]);

  return <RealtimeProvider client={port}>{children}</RealtimeProvider>;
}
