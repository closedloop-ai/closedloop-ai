import "server-only";
import { Liveblocks as LiveblocksNode } from "@liveblocks/node";
import { keys } from "./keys";

type AuthenticateOptions = {
  userId: string;
  organizationId: string;
  userInfo: Liveblocks["UserMeta"]["info"];
};

const secret = keys().LIVEBLOCKS_SECRET;

export async function authenticate({
  userId,
  organizationId,
  userInfo,
}: AuthenticateOptions): Promise<{ token: string; status: number }> {
  if (!secret) {
    throw new Error("LIVEBLOCKS_SECRET is not set");
  }

  const liveblocks = new LiveblocksNode({ secret });

  const session = liveblocks.prepareSession(userId, {
    userInfo,
    tenantId: organizationId,
  });

  session.allow(`${organizationId}:artifact:*`, [
    ...session.FULL_ACCESS,
    "room:read",
    "comments:read",
  ]);

  const { status, body } = await session.authorize();
  return { token: body, status };
}
