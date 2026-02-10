import "server-only";
import { Liveblocks as LiveblocksNode } from "@liveblocks/node";
import { keys } from "./keys";
import { parseArtifactRoomId } from "./room-utils";

type AuthenticateOptions = {
  userId: string;
  roomId: string;
  userInfo: Liveblocks["UserMeta"]["info"];
};

const secret = keys().LIVEBLOCKS_SECRET;

export const authenticate = async ({
  userId,
  roomId,
  userInfo,
}: AuthenticateOptions) => {
  if (!secret) {
    throw new Error("LIVEBLOCKS_SECRET is not set");
  }

  const liveblocks = new LiveblocksNode({ secret });
  let tenantId: string | undefined;

  try {
    const { organizationId } = parseArtifactRoomId(roomId);
    tenantId = organizationId;
  } catch {}

  const session = liveblocks.prepareSession(userId, {
    userInfo,
    tenantId,
  });

  session.allow(roomId, session.FULL_ACCESS);

  const { status, body } = await session.authorize();
  return { token: body, status };
};
