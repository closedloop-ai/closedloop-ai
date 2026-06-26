import "server-only";
// Loads the `Liveblocks` global type augmentation (UserMeta, etc.) into this
// module's program. Required since the index barrel was removed — nothing else
// pulls the declaration in for server-side consumers (apps/api).
import "../shared/config";
import { Liveblocks as LiveblocksNode } from "@liveblocks/node";
import { keys } from "./keys";

type AuthenticateOptions = {
  userId: string;
  organizationId: string;
  userInfo: Liveblocks["UserMeta"]["info"];
};

export async function authenticate({
  userId,
  organizationId,
  userInfo,
}: AuthenticateOptions): Promise<{ token: string; status: number }> {
  // Read per-call (not at module init) so cold starts and test isolation see
  // the current env, matching the other server modules in this directory.
  const secret = keys().LIVEBLOCKS_SECRET;
  if (!secret) {
    throw new Error("LIVEBLOCKS_SECRET is not set");
  }

  const liveblocks = new LiveblocksNode({ secret });

  const session = liveblocks.prepareSession(userId, {
    userInfo,
    organizationId,
  });

  session.allow(`${organizationId}:artifact:*`, session.FULL_ACCESS);

  // `session.authorize()` returns the Liveblocks auth payload as a JSON string
  // (`{"token":"..."}`), not a bare JWT. The route forwards this body verbatim
  // as the HTTP response; the client's LiveblocksProvider parses it back to
  // `{ token }`. Returned here under `token` for the route's response body.
  const { status, body } = await session.authorize();
  return { token: body, status };
}
