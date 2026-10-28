import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  createSessionAttributionResolverCache,
  resolveSessionAttributionAsync,
} from "../agent-sync/agent-session-attribution.js";
import { createAttributionYieldCadence } from "../agent-sync/attribution-path-memo.js";
import { REPOSITORY_PAIR_KEY_EXPR } from "./db-constants.js";
import type { DesktopPrisma } from "./prisma-client.js";

type SearchPair = {
  pairKey: string;
  cwd: string | null;
  repoFullName: string | null;
};

type BranchFallback = {
  sessionId: string;
  repoFullName: string;
  relation: string | null;
};

export type SessionListSearchContext = {
  matchingPairKeys: string[];
  fallbackSessionIds: string[];
};

/** Resolve on-disk branch and repository search fields once per distinct pair before the SQLite page snapshot. */
export async function resolveSessionListSearchContext(
  prisma: DesktopPrisma,
  search: string,
  window: { clause: string; params: unknown[] }
): Promise<SessionListSearchContext> {
  const pairs = await prisma.read((reader) =>
    reader.$queryRawUnsafe<SearchPair[]>(
      `SELECT ${REPOSITORY_PAIR_KEY_EXPR} AS pairKey,
              s.cwd AS cwd, s.repo_full_name AS repoFullName
       FROM sessions s ${window.clause}
       GROUP BY pairKey`,
      ...window.params
    )
  );
  const matchingPairKeys: string[] = [];
  const missingRepoPairKeys: string[] = [];
  const cache = createSessionAttributionResolverCache();
  const yieldTick = createAttributionYieldCadence();
  const needle = search.toLowerCase();
  for (const pair of pairs) {
    await yieldTick();
    const live = await resolveSessionAttributionAsync(pair.cwd, cache);
    const repositoryFullName =
      live?.repositoryFullName ?? pair.repoFullName ?? null;
    if (
      repositoryFullName?.toLowerCase().includes(needle) ||
      live?.baseBranch?.toLowerCase().includes(needle)
    ) {
      matchingPairKeys.push(pair.pairKey);
    }
    if (!repositoryFullName) {
      missingRepoPairKeys.push(pair.pairKey);
    }
  }
  if (missingRepoPairKeys.length === 0) {
    return { matchingPairKeys, fallbackSessionIds: [] };
  }
  const fallbackLinks = await prisma.read((reader) =>
    reader.$queryRawUnsafe<BranchFallback[]>(
      `SELECT s.id AS sessionId, a.repo_full_name AS repoFullName,
              sal.relation AS relation
       FROM sessions s
       JOIN session_artifact_links sal ON sal.session_id = s.id
       JOIN artifacts a ON a.id = sal.artifact_id
       WHERE ${REPOSITORY_PAIR_KEY_EXPR} IN (SELECT value FROM json_each($1))
         AND a.kind = 'branch' AND a.repo_full_name IS NOT NULL
         AND a.repo_full_name <> ''
       ORDER BY s.id ASC, sal.created_at ASC`,
      JSON.stringify(missingRepoPairKeys)
    )
  );
  const preferred = new Map<string, { repository: string; created: boolean }>();
  for (const link of fallbackLinks) {
    const current = preferred.get(link.sessionId);
    const created = link.relation === "created";
    if (!current || (created && !current.created)) {
      preferred.set(link.sessionId, {
        repository: normalizeRepoFullName(link.repoFullName),
        created,
      });
    }
  }
  const fallbackSessionIds = [...preferred]
    .filter(([, value]) => value.repository.toLowerCase().includes(needle))
    .map(([id]) => id);
  return { matchingPairKeys, fallbackSessionIds };
}
