import type { User } from "@repo/api/src/types/user";
import { authenticate } from "@repo/collaboration/server/auth";
import { parseDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { getConsistentColor } from "@repo/collaboration/shared/user-colors";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { usersService } from "../../users/service";

/**
 * Liveblocks room-auth endpoint (FEA-1510). Mints an org-scoped Liveblocks
 * token for the authenticated caller. Lives in apps/api — rather than a Next
 * route in apps/app — so both the web shell (Clerk session) and the desktop
 * renderer (bearer token) authenticate through the same dual-mode path via
 * `resolveAnyAuthContext`. The response body is the raw Liveblocks authorize
 * payload (`{ token }`), not the BFF `ApiResult` envelope, because the client's
 * `LiveblocksProvider` auth callback consumes it directly.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // Require write scope: a successful auth mints a FULL_ACCESS Liveblocks
    // session (comment + Y.Doc mutations), so a read-only API key must not pass.
    // Scopes are only enforced for `sk_live_*` callers; Clerk sessions (the web
    // shell's path) bypass the scope check.
    const authContext = await resolveAnyAuthContext(request, {
      requiredScopes: ["write"],
    });
    if (!authContext) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { userId, organizationId } = authContext;

    let roomId: string | undefined;
    try {
      const { room } = authenticateValidator.parse(await request.json());
      roomId = room;
    } catch (error) {
      log.error("Invalid request body", { error });
      return new Response("Invalid request body", { status: 400 });
    }

    if (roomId) {
      try {
        const { organizationId: roomOrganizationId } =
          parseDocumentRoomId(roomId);
        if (roomOrganizationId !== organizationId) {
          return new Response("Forbidden", { status: 403 });
        }
      } catch (error) {
        log.error("Invalid room ID", { error });
        return new Response("Invalid room ID", { status: 400 });
      }
    }

    const user = await usersService.findById(userId, organizationId);
    if (!user) {
      return new Response("Unable to fetch user", { status: 500 });
    }

    const { token, status } = await authenticate({
      userId: user.id,
      organizationId,
      userInfo: {
        name: getUserName(user),
        avatar: user.avatarUrl ?? undefined,
        color: getConsistentColor(user.id),
      },
    });

    return new Response(token, { status });
  } catch (error) {
    log.error("Collaboration auth error", { error });
    return new Response("Unable to authenticate", { status: 500 });
  }
}

const authenticateValidator = z.object({
  room: z.string().min(1, "room is required").optional(),
});

function getUserName(user: User): string {
  if (user.firstName && user.lastName) {
    return `${user.firstName} ${user.lastName}`;
  }
  if (user.firstName) {
    return user.firstName;
  }
  if (user.email) {
    return user.email;
  }
  return "Anonymous";
}
