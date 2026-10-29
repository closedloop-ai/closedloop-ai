import { log } from "@repo/observability/log";
import type { Socket } from "socket.io";
import { apiKeysService } from "../app/api-keys/service";
import { usersService } from "../app/users/service";
import { getDesktopManagedPopRequestFailure } from "./auth/desktop-managed-pop";
import type { DesktopAuthContext } from "./desktop-gateway-types";

const DESKTOP_SOCKET_POP_VERIFICATION_PATH = "/internal/api-keys/verify";

/**
 * Resolves the API-key identity behind a desktop gateway socket handshake, or
 * `null` when the connection is not authorized.
 *
 * Extracted from `desktop-gateway-socket-server.ts`, which is over the
 * `noExcessiveLinesPerFile` ceiling and shrink-only. Handshake auth is a
 * self-contained responsibility: it reads only the socket's own handshake and
 * touches none of the server's connection registries.
 *
 * The API-key check is INLINED rather than delegated to
 * `resolveApiKeyTokenContext`: `resolve-any-auth-context.ts` transitively pulls
 * in `clerk-service` → `server-only`, which throws at require time in the
 * custom socket server (it runs under `tsx`, outside Next.js).
 */
export async function resolveDesktopAuthContext(
  socket: Socket
): Promise<DesktopAuthContext | null> {
  const apiKey = extractApiKey(socket);
  if (!apiKey) {
    return null;
  }

  const keyContext = await apiKeysService.verifyKeyWithMetadata(apiKey, {
    updateLastUsedAt: false,
  });
  if (!keyContext) {
    return null;
  }

  if (!keyContext.scopes.includes("write")) {
    return null;
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return null;
  }

  const popFailure = await getDesktopManagedPopRequestFailure({
    keyContext: { ...keyContext, clerkUserId: user.clerkId },
    request: buildDesktopSocketPopVerificationRequest(socket),
  });
  if (popFailure) {
    log.warn("Desktop gateway socket PoP auth rejected", {
      socketId: socket.id,
      status: popFailure.status,
    });
    return null;
  }

  apiKeysService.touchLastUsedAt(keyContext.apiKeyId).catch((error) => {
    log.warn("Failed updating desktop socket API key last-used timestamp", {
      socketId: socket.id,
      apiKeyId: keyContext.apiKeyId,
      error,
    });
  });

  return {
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
    clerkUserId: user.clerkId,
    apiKeySource: keyContext.source,
    apiKeyGatewayId: keyContext.gatewayId,
    apiKeyBoundPublicKey: keyContext.boundPublicKey,
  };
}

function extractApiKey(socket: Socket): string | null {
  let authToken: string | null = null;
  if (typeof socket.handshake.auth?.token === "string") {
    authToken = socket.handshake.auth.token;
  } else if (typeof socket.handshake.auth?.apiKey === "string") {
    authToken = socket.handshake.auth.apiKey;
  }

  const authHeader = socket.handshake.headers.authorization;
  const headerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  const token = authToken ?? headerToken;
  if (!token?.startsWith("sk_live_")) {
    return null;
  }
  return token;
}

function buildDesktopSocketPopVerificationRequest(socket: Socket): Request {
  // Direct Socket.IO connects reuse the same PoP proof Desktop signs for relay
  // API-key validation; relay and direct paths should accept the same handshake.
  return new Request(
    `https://desktop-gateway.local${DESKTOP_SOCKET_POP_VERIFICATION_PATH}`,
    {
      method: "POST",
      headers: toRequestHeaders(socket.handshake.headers),
    }
  );
}

function toRequestHeaders(headers: Socket["handshake"]["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(name, entry);
      }
    } else if (typeof value === "string") {
      result.set(name, value);
    }
  }
  return result;
}
