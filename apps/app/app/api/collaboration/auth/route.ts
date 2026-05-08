import type { User } from "@repo/api/src/types/user";
import { auth } from "@repo/auth/server";
import { authenticate } from "@repo/collaboration/auth";
import { parseDocumentRoomId } from "@repo/collaboration/room-utils";
import { getConsistentColor } from "@repo/collaboration/user-colors";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import z from "zod";
import { fetchUser } from "../fetch-user";

export async function POST(request: Request): Promise<Response> {
  try {
    const { userId, getToken } = await auth();

    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    let roomId: string | undefined;
    try {
      const { room } = authenticateValidator.parse(await request.json());
      roomId = room;
    } catch (error) {
      log.error("Invalid request body", { error: parseError(error) });
      return new Response("Invalid request body", { status: 400 });
    }

    const user = await fetchUser(getToken);
    if (!user) {
      return new Response("Unable to fetch user", { status: 500 });
    }

    if (roomId) {
      try {
        const { organizationId } = parseDocumentRoomId(roomId);
        if (organizationId !== user.organizationId) {
          return new Response("Forbidden", { status: 403 });
        }
      } catch (error) {
        log.error("Invalid room ID", { error: parseError(error) });
        return new Response("Invalid room ID", { status: 400 });
      }
    } else {
      log.info("Global collaboration token requested", {
        userId: user.id,
        organizationId: user.organizationId,
      });
    }

    const { token, status } = await authenticate({
      userId: user.id,
      organizationId: user.organizationId,
      userInfo: {
        name: getUserName(user),
        avatar: user.avatarUrl ?? undefined,
        color: getConsistentColor(user.id),
      },
    });

    return new Response(token, { status });
  } catch (error) {
    log.error("Collaboration auth error", { error: parseError(error) });
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
