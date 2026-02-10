import "server-only";
import { Liveblocks as LiveblocksNode } from "@liveblocks/node";
import { keys } from "./keys";
import { parseArtifactRoomId } from "./room-utils";

type AuthenticateOptions = {
  userId: string;
  roomId?: string;
  organizationId?: string;
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
  organizationId,
  userInfo,
}: AuthenticateOptions): Promise<{ token: string; status: number }> {
  if (!secret) {
    throw new Error("LIVEBLOCKS_SECRET is not set");
  }

  if (!(roomId || organizationId)) {
    throw new Error(
      "organizationId is required for global tokens (when roomId is not provided)"
    );
  }

  const liveblocks = new LiveblocksNode({ secret });
  const tenantId = roomId
    ? (extractTenantId(roomId) ?? organizationId)
    : organizationId;

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
