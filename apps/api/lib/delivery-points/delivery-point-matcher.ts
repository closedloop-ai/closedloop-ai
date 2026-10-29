/**
 * The MATCHER (ISS-8399): provider rows in, our records out.
 *
 * This is the hard stage of extract → match → attach. The first and third are
 * mechanical; this one decides what a row IS, and getting it confidently wrong
 * charges one pull request with another's points.
 *
 * The rules it implements, each of which exists because the naive version is
 * wrong in a specific way:
 *
 * - **The join key is `(normalized owner/repo, number)`.** Both halves are
 *   parsed from the feed and neither is assumed — the feed spans repositories.
 *   A row with no repository half is UNMATCHABLE, never bucketed: this repo's
 *   own review lessons name dedup on a nullable field as a silent double-count.
 * - **Titles are never used to attach anything.** They are not unique, they are
 *   lossy three separate ways (`+ N more` truncation, slash-runs like
 *   `ISS-4642/4643/4644`, multi-clause titles) and they embed unescaped quotes.
 *   A title slug does not establish the repository/PR identity this store keys
 *   on, so a row the matcher could not identify gets its OUTCOME and NO
 *   artifacts. Attaching one anyway is "pick the first" wearing a different hat:
 *   it takes a row we just said we could not identify and attributes it. An
 *   unmatched row is visible; a wrongly attributed one is not.
 * - **Ambiguity is an outcome, not a tie-break.** More than one candidate
 *   resolves to `AMBIGUOUS`, never to the first row Postgres returned.
 * - **Every artifact is linked, not one.** A pull request routinely addresses
 *   several tickets; the set comes from our own branch/PR links.
 * - **People bridge on email, case-insensitively.** The feed carries no GitHub
 *   login, and its `username` differs in case from its `email` for real users.
 */

import {
  DeliveryArtifactLinkSource,
  DeliveryMatchOutcome,
  withDb,
} from "@repo/database";
import {
  PullRequestResolution,
  type ResolvedDeliveryRow,
} from "@repo/pensero/delivery-interaction-join";
import { pullRequestRefFullName } from "@repo/pensero/delivery-parse";
import {
  type ExternalDeliveryPullRequestCandidate,
  externalDeliveryPullRequestKey,
  readExternalDeliveryPullRequestCandidates,
} from "./external-delivery-pull-request-population";
import { chunked } from "./lookup-chunk";

/** One artifact this delivery row resolves to, and how it was resolved. */
export type DeliveryArtifactAssociation = {
  readonly artifactId: string;
  readonly source: DeliveryArtifactLinkSource;
};

/** What one delivery row matched to on our side. */
export type DeliveryMatchTarget = {
  readonly outcome: DeliveryMatchOutcome;
  readonly repositoryFullName: string | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestDetailId: string | null;
  /**
   * The matched pull request's BRANCH artifact — its only real identity in the
   * artifact graph. NOT `pull_request_detail.artifact_id`, which is vestigial
   * and normally null, so keying on it would make a successful match look like
   * a coverage hole.
   */
  readonly branchArtifactId: string | null;
  /**
   * EVERY artifact this row resolves to — the pull request, its branch, and the
   * issues/plans our own links reach. EMPTY unless `outcome` is `MATCHED`: an
   * artifact set is a claim about which work this delivery belongs to, and a row
   * we could not identify has no standing to make one.
   */
  readonly artifacts: readonly DeliveryArtifactAssociation[];
};

/** Everything the store needs, keyed by the provider's own row id. */
export type DeliveryMatchResult = {
  readonly targetsByItemId: ReadonlyMap<string, DeliveryMatchTarget>;
  /** Lowercased provider email → our user id, or null when unbridged. */
  readonly userIdByEmail: ReadonlyMap<string, string | null>;
};

/**
 * Bridge the feed's people to our users on lowercased email, scoped to the org.
 *
 * Case-insensitive by construction: `User.email` has no case-folding collation,
 * and the provider's own `username` demonstrates that the same person's address
 * arrives in more than one casing. A case-sensitive compare would split one
 * person into a bridged half and an unbridged half.
 *
 * Every requested email gets an entry, `null` included — an absent key and a
 * `null` value would otherwise be indistinguishable to the caller, and only one
 * of them means "we looked and there is no such user".
 */
export async function bridgePeopleByEmail(
  organizationId: string,
  emails: readonly string[]
): Promise<Map<string, string | null>> {
  const wanted = [...new Set(emails)].filter((email) => email.length > 0);
  const bridged = new Map<string, string | null>(
    wanted.map((email) => [email, null])
  );
  for (const chunk of chunked(wanted)) {
    const users = await withDb((db) =>
      db.user.findMany({
        where: {
          organizationId,
          OR: chunk.map((email) => ({
            email: { equals: email, mode: "insensitive" as const },
          })),
        },
        select: { id: true, email: true },
      })
    );
    for (const user of users) {
      const key = user.email.trim().toLowerCase();
      if (bridged.has(key)) {
        bridged.set(key, user.id);
      }
    }
  }
  return bridged;
}

/**
 * Match a batch of interaction-resolved rows against our records.
 *
 * The batch is matched as a batch — candidate pull requests and their links are
 * each read once for the whole set rather than per row — so a segment costs a
 * bounded number of statements regardless of size.
 */
export async function matchDeliveryRows(
  organizationId: string,
  resolved: readonly ResolvedDeliveryRow[]
): Promise<DeliveryMatchResult> {
  const userIdByEmail = await bridgePeopleByEmail(
    organizationId,
    resolved.map((entry) => entry.row.person.email)
  );

  const candidatesByKey = await loadPullRequestCandidates(
    organizationId,
    resolved
  );
  const artifactIdsByPrKey = await loadLinkedArtifacts(
    organizationId,
    candidatesByKey
  );
  const targetsByItemId = new Map<string, DeliveryMatchTarget>();
  for (const entry of resolved) {
    targetsByItemId.set(
      entry.row.itemId,
      buildTarget(entry, candidatesByKey, artifactIdsByPrKey)
    );
  }
  return { targetsByItemId, userIdByEmail };
}

/**
 * Collect the DISTINCT pull requests this batch references, then resolve them
 * through the external-delivery population owner — which is where the raw read
 * and its ambiguity contract live (ISS-8399 / the `pull-request-population-
 * declaration` gate).
 */
function loadPullRequestCandidates(
  organizationId: string,
  resolved: readonly ResolvedDeliveryRow[]
): Promise<Map<string, ExternalDeliveryPullRequestCandidate[]>> {
  const wanted = new Map<
    string,
    { repositoryFullName: string; number: number }
  >();
  for (const entry of resolved) {
    if (!entry.pullRequest) {
      continue;
    }
    const repositoryFullName = pullRequestRefFullName(entry.pullRequest);
    wanted.set(
      externalDeliveryPullRequestKey(
        repositoryFullName,
        entry.pullRequest.number
      ),
      { repositoryFullName, number: entry.pullRequest.number }
    );
  }
  return readExternalDeliveryPullRequestCandidates(organizationId, [
    ...wanted.values(),
  ]);
}

/**
 * For each unambiguous pull request, the full artifact set our own links reach:
 * its branch artifact (the pull request's real identity in the artifact graph),
 * its vestigial own artifact when a legacy row still has one, and everything
 * one link hop away from either in EITHER direction. This is the authoritative
 * set — the provider's title is not consulted here at all.
 */
async function loadLinkedArtifacts(
  organizationId: string,
  candidatesByKey: ReadonlyMap<string, ExternalDeliveryPullRequestCandidate[]>
): Promise<Map<string, string[]>> {
  const seeds = new Map<string, string[]>();
  for (const [key, candidates] of candidatesByKey) {
    if (candidates.length !== 1) {
      continue;
    }
    const [candidate] = candidates;
    const seedIds = [candidate.branchArtifactId, candidate.artifactId].filter(
      (id): id is string => Boolean(id)
    );
    seeds.set(key, [...new Set(seedIds)]);
  }

  const allSeedIds = [...new Set([...seeds.values()].flat())];
  const neighboursBySeed = new Map<string, Set<string>>();
  for (const chunk of chunked(allSeedIds)) {
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          OR: [{ sourceId: { in: chunk } }, { targetId: { in: chunk } }],
        },
        select: { sourceId: true, targetId: true },
      })
    );
    const chunkSet = new Set(chunk);
    for (const link of links) {
      if (chunkSet.has(link.sourceId)) {
        addNeighbour(neighboursBySeed, link.sourceId, link.targetId);
      }
      if (chunkSet.has(link.targetId)) {
        addNeighbour(neighboursBySeed, link.targetId, link.sourceId);
      }
    }
  }

  const byKey = new Map<string, string[]>();
  for (const [key, seedIds] of seeds) {
    const set = new Set<string>(seedIds);
    for (const seedId of seedIds) {
      for (const neighbour of neighboursBySeed.get(seedId) ?? []) {
        set.add(neighbour);
      }
    }
    byKey.set(key, [...set]);
  }
  return byKey;
}

function addNeighbour(
  map: Map<string, Set<string>>,
  seedId: string,
  neighbourId: string
): void {
  if (seedId === neighbourId) {
    return;
  }
  const bucket = map.get(seedId) ?? new Set<string>();
  bucket.add(neighbourId);
  map.set(seedId, bucket);
}

/**
 * Classify one row into exactly one outcome.
 *
 * The order matters: a row that never named a pull request is UNMATCHABLE (we
 * never got as far as a lookup), which is a different fact from NO_COUNTERPART
 * (we looked, and we do not have it). Collapsing the two would make "the
 * provider's feed is short" read the same as "our data is short".
 */
function buildTarget(
  entry: ResolvedDeliveryRow,
  candidatesByKey: ReadonlyMap<string, ExternalDeliveryPullRequestCandidate[]>,
  artifactIdsByPrKey: ReadonlyMap<string, string[]>
): DeliveryMatchTarget {
  if (entry.resolution === PullRequestResolution.Ambiguous) {
    return unresolvedTarget(DeliveryMatchOutcome.AMBIGUOUS);
  }
  if (!entry.pullRequest) {
    return unresolvedTarget(unresolvedOutcomeFor(entry.resolution));
  }

  const fullName = pullRequestRefFullName(entry.pullRequest);
  const key = externalDeliveryPullRequestKey(
    fullName,
    entry.pullRequest.number
  );
  const candidates = candidatesByKey.get(key) ?? [];

  if (candidates.length !== 1) {
    // Zero candidates is a well-formed reference to a pull request we do not
    // have; more than one is a reference we cannot arbitrate. Neither picks a
    // winner, and both keep the parsed reference so an operator can see WHICH
    // pull request went unmatched — that reference is what makes an unmatched
    // row actionable rather than an anonymous coverage hole. Neither attaches
    // an artifact: we did not identify the pull request, so we have nothing
    // whose artifacts these would be.
    return {
      outcome:
        candidates.length === 0
          ? DeliveryMatchOutcome.NO_COUNTERPART
          : DeliveryMatchOutcome.AMBIGUOUS,
      repositoryFullName: fullName,
      pullRequestNumber: entry.pullRequest.number,
      pullRequestDetailId: null,
      branchArtifactId: null,
      artifacts: [],
    };
  }

  const [candidate] = candidates;
  return {
    outcome: DeliveryMatchOutcome.MATCHED,
    repositoryFullName: fullName,
    pullRequestNumber: entry.pullRequest.number,
    pullRequestDetailId: candidate.detailId,
    branchArtifactId: candidate.branchArtifactId,
    artifacts: (artifactIdsByPrKey.get(key) ?? []).map((artifactId) => ({
      artifactId,
      source: DeliveryArtifactLinkSource.OUR_LINKS,
    })),
  };
}

/**
 * A row we could not resolve to exactly one of our pull requests carries its
 * OUTCOME and nothing else. The pull-request fields stay null — writing the
 * parsed-but-unmatched repository there would make a NO_COUNTERPART row look
 * partially matched — and the artifact set is EMPTY, because the only thing
 * that could have filled it is the row's title, which does not establish the
 * repository/PR identity everything downstream keys on.
 */
function unresolvedTarget(outcome: DeliveryMatchOutcome): DeliveryMatchTarget {
  return {
    outcome,
    repositoryFullName: null,
    pullRequestNumber: null,
    pullRequestDetailId: null,
    branchArtifactId: null,
    artifacts: [],
  };
}

/**
 * Which unresolved outcome a row without a pull request earns.
 *
 * The two are NOT the same fact and must not share a stored value. A row naming
 * no pull-request interaction at all (a Slack message, a Pensero ticket) can
 * never acquire one — UNMATCHABLE is terminal and correct. A row that DOES name
 * a pull-request interaction but whose number no row has supplied yet is
 * PENDING_REFERENCE: the counterpart may simply be in a window this run did not
 * fetch, and writing it as terminal is a confident claim the run cannot make.
 */
function unresolvedOutcomeFor(
  resolution: ResolvedDeliveryRow["resolution"]
): DeliveryMatchOutcome {
  return resolution === PullRequestResolution.NoCounterpart
    ? DeliveryMatchOutcome.PENDING_REFERENCE
    : DeliveryMatchOutcome.UNMATCHABLE;
}
