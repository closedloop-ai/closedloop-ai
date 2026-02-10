import "server-only";
import { Liveblocks as LiveblocksNode } from "@liveblocks/node";
import { keys } from "./keys";
import { parseArtifactRoomId } from "./room-utils";

type AuthenticateOptions = {
  userId: string;
  roomId?: string;
  userInfo: Liveblocks["UserMeta"]["info"];
};

const secret = keys().LIVEBLOCKS_SECRET;

function extractTenantId(roomId: string): string | undefined {
  try {
    return parseArtifactRoomId(roomId).organizationId;
  } catch {
    return undefined;
  }
}

export async function authenticate({
  userId,
  roomId,
  userInfo,
}: AuthenticateOptions): Promise<{ token: string; status: number }> {
  if (!secret) {
    throw new Error("LIVEBLOCKS_SECRET is not set");
  }

  const liveblocks = new LiveblocksNode({ secret });
  const tenantId = roomId ? extractTenantId(roomId) : undefined;

  const session = liveblocks.prepareSession(userId, {
    userInfo,
    tenantId,
  });

  // Room-scoped token when roomId is provided; user-scoped via tenantId otherwise
  if (roomId) {
    session.allow(roomId, session.FULL_ACCESS);
  }

  const { status, body } = await session.authorize();
  return { token: body, status };
}
