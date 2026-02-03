import "server-only";
import { Liveblocks as LiveblocksNode } from "@liveblocks/node";
import { keys } from "./keys";

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
  const session = liveblocks.prepareSession(userId, { userInfo });

  session.allow(roomId, session.FULL_ACCESS);

  const { status, body } = await session.authorize();
  return { token: body, status };
};
