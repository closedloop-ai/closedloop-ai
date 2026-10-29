import { ApiKeySource } from "@repo/database/generated/enums";
import { type Mock, vi } from "vitest";

export type DesktopGatewayTestSocketHandler = (...args: unknown[]) => unknown;

type TestSocketOptions = {
  authenticated?: boolean;
  connected?: boolean;
  idPrefix?: string;
};

let nextSocketId = 0;
const liveSockets = new Set<DesktopGatewayTestSocket>();

export type DesktopGatewayTestSocket = {
  id: string;
  connected: boolean;
  data: {
    authContext?: {
      organizationId: string;
      userId: string;
      clerkUserId: string;
      apiKeySource: ApiKeySource;
      apiKeyGatewayId: string;
      apiKeyBoundPublicKey: string;
    };
  };
  disconnect: Mock<(...args: unknown[]) => unknown>;
  emit: Mock<(...args: unknown[]) => unknown>;
  on: Mock<
    (
      event: string,
      handler: DesktopGatewayTestSocketHandler
    ) => DesktopGatewayTestSocket
  >;
};

type DesktopGatewayTestSocketHarness = {
  handlers: Map<string, DesktopGatewayTestSocketHandler>;
  socket: DesktopGatewayTestSocket;
};

export function makeDesktopGatewayTestSocket(
  options: TestSocketOptions = {}
): DesktopGatewayTestSocketHarness {
  nextSocketId += 1;
  const handlers = new Map<string, DesktopGatewayTestSocketHandler>();
  const socket: DesktopGatewayTestSocket = {
    id: `${options.idPrefix ?? "direct-socket"}-${nextSocketId}`,
    connected: options.connected ?? true,
    data:
      options.authenticated === false
        ? {}
        : {
            authContext: {
              organizationId: "org-1",
              userId: "user-1",
              clerkUserId: "clerk-1",
              apiKeySource: ApiKeySource.DESKTOP_MANAGED,
              apiKeyGatewayId: "gateway-1",
              apiKeyBoundPublicKey: "public-key-1",
            },
          },
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: DesktopGatewayTestSocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
  };
  liveSockets.add(socket);
  return { handlers, socket };
}

/**
 * Trigger every registered disconnect handler so module-scoped gateway
 * contexts and heartbeat timers cannot leak between tests.
 */
export async function cleanupDesktopGatewayTestSockets(): Promise<void> {
  for (const socket of liveSockets) {
    socket.connected = false;
    const disconnectHandler = socket.on.mock.calls.find(
      ([event]) => event === "disconnect"
    )?.[1] as DesktopGatewayTestSocketHandler | undefined;
    disconnectHandler?.();
  }
  liveSockets.clear();
  await Promise.resolve();
  await Promise.resolve();
  vi.clearAllTimers();
}
