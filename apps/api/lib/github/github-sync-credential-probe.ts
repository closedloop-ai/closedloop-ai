import { withDb } from "@repo/database";
import type { GetGitHubSyncClientInput } from "@/lib/github/github-sync-client-pool";
import { findCoveringInstallation } from "@/lib/github/installation-repository-lookup";

/**
 * Whether `getGitHubSyncClient` has nothing to draw for `input`: no active
 * installation covers the repository and the org's pool holds no connection,
 * which the draw denies as `not_connected`. Reads only: it takes no token,
 * claims no connection, and spends no budget. A pool whose every owner Clerk
 * cannot serve also denies `not_connected`; seeing that needs a token
 * acquisition, so this reports such a pool as non-empty.
 */
export async function gitHubSyncPoolIsEmpty(
  input: GetGitHubSyncClientInput
): Promise<boolean> {
  const covering = await findCoveringInstallation(
    input.organizationId,
    `${input.target.owner}/${input.target.repo}`
  );
  if (covering) {
    return false;
  }
  const connection = await withDb((db) =>
    db.gitHubUserConnection.findFirst({
      where: { organizationId: input.organizationId },
      select: { id: true },
    })
  );
  return connection === null;
}
