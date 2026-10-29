import type { AgentSessionUsageAggregateFilters } from "../agent-sync/agent-session-read-model.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import { buildUsageFilterClause } from "./session-aggregate-filters.js";
import { readRepositoryScopedSnapshot } from "./session-repository-snapshot.js";

/** Probe repository identities outside the transaction; group SQL reads in one snapshot. */
export function readResolvedUsageSnapshot<T>(
  prisma: DesktopPrisma,
  filters: AgentSessionUsageAggregateFilters,
  read: (
    snapshot: DesktopPrismaReader,
    clause: string,
    params: unknown[],
    validation: { clause: string; params: unknown[] }
  ) => Promise<T>
): Promise<T> {
  const base = buildUsageFilterClause({ ...filters, quality: "all" });
  return readRepositoryScopedSnapshot(
    prisma,
    filters.repositories,
    base,
    (snapshot, repositoryPairKeys) => {
      const { clause, params } = buildUsageFilterClause({
        ...filters,
        ...(repositoryPairKeys === undefined ? {} : { repositoryPairKeys }),
      });
      const validation = buildUsageFilterClause({
        ...filters,
        quality: "all",
        ...(repositoryPairKeys === undefined ? {} : { repositoryPairKeys }),
      });
      return read(snapshot, clause, params, validation);
    }
  );
}
