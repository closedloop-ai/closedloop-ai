import type { DesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import { isRecord } from "@/lib/type-guards";
import {
  retryUnacknowledgedSessions,
  StallPolicy,
} from "../core/acknowledgement-retry";
import { ingestGoldenCorpus } from "../core/golden-import";
import { seedPersonOwners } from "../core/session-owners";
import type { VibeSeedContext } from "../stage";
import { pullRequestFactsLookup, readGoldenGitHubCorpus } from "./corpus";
import { ensureSeededRepositories } from "./repositories";
import { buildGoldenSessionRefs, type GoldenSessionRefs } from "./store-refs";

/**
 * ISS-12017: link the golden sessions to the branches and pull requests they
 * worked on, through the production linking path. The golden import sends no
 * `artifactRefs`/`prRefs`, so this stage re-delivers every golden session that
 * has refs into a seeded repository with those refs attached, through the same
 * `ingestGoldenCorpus` → `handleDesktopAgentSessionsEvent` fold. The fold
 * materializes the BRANCH artifacts, `BranchDetail`, `PullRequestDetail`,
 * session links, desktop-parsed `CommitDetail` rows, and the org's
 * `GitHubObservedRepository` observations, exactly as a Desktop resync would.
 */

export async function linkGoldenSessionsToBranches(
  context: VibeSeedContext
): Promise<void> {
  await ensureSeededRepositories(context);
  const corpus = readGoldenGitHubCorpus(context);
  const refsBySession = buildGoldenSessionRefs(
    corpus.links,
    pullRequestFactsLookup(corpus)
  );
  const fold = retryUnacknowledgedSessions(
    handleDesktopAgentSessionsEvent,
    context.log,
    StallPolicy.Fail
  );
  const summary = await ingestGoldenCorpus(
    {
      storePath: corpus.storePath,
      organizationId: context.organizationId,
      resolveOwner: seedPersonOwners(context),
      shift: { shiftMs: context.corpusShiftMs, nowMs: context.now.getTime() },
      log: context.log,
    },
    {
      handle: (payload, handlerContext, deps) =>
        deliverWithRefs(payload, refsBySession, (withRefs) =>
          fold(withRefs, handlerContext, deps)
        ),
    }
  );
  if (summary.sessionsPersisted < refsBySession.size) {
    throw new Error(
      `only ${summary.sessionsPersisted} of ${refsBySession.size} linked golden session(s) were persisted on re-delivery`
    );
  }
  context.log(
    `re-delivered ${refsBySession.size} golden session(s) with branch, pull request, and commit refs; ${Math.max(0, summary.sessionsRead - refsBySession.size)} store session(s) carry none and are not re-sent`
  );
}

/**
 * Keep only the batch's sessions that carry refs, attach those refs, and hand
 * the batch to the fold; a batch left empty is acknowledged without a call.
 */
export function deliverWithRefs(
  payload: unknown,
  refsBySession: ReadonlyMap<string, GoldenSessionRefs>,
  deliver: (
    payload: Record<string, unknown>
  ) => Promise<DesktopAgentSessionsAck>
): Promise<DesktopAgentSessionsAck> {
  if (!(isRecord(payload) && Array.isArray(payload.sessions))) {
    throw new Error("the golden import handed over a batch without sessions");
  }
  const sessions = payload.sessions.flatMap((session: unknown) => {
    if (!isRecord(session)) {
      return [];
    }
    const refs = refsBySession.get(String(session.externalSessionId));
    return refs === undefined
      ? []
      : [{ ...session, artifactRefs: refs.artifactRefs, prRefs: refs.prRefs }];
  });
  if (sessions.length === 0) {
    return Promise.resolve({ accepted: true, acceptedSessionIds: [] });
  }
  return deliver({ ...payload, sessions, sessionCount: sessions.length });
}
