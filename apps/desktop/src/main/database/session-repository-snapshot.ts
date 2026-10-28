import { createSessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import { resolveMatchedRepositoryPairKeys } from "./session-repository-scoped-reads.js";

/** Resolve live repository identities before the short SQLite read snapshot. */
export async function readRepositoryScopedSnapshot<T>(
  prisma: DesktopPrisma,
  repositories: readonly string[] | undefined,
  window: { clause: string; params: unknown[] },
  read: (
    snapshot: DesktopPrismaReader,
    repositoryPairKeys?: string[]
  ) => Promise<T>
): Promise<T> {
  const keys = repositories?.length
    ? await resolveMatchedRepositoryPairKeys(
        prisma,
        repositories,
        createSessionAttributionResolverCache(),
        window
      )
    : undefined;
  return prisma.read((reader) =>
    reader.$transaction((snapshot) => read(snapshot, keys))
  );
}
