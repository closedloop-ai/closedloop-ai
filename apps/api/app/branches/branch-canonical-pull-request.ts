/**
 * ISS-8153 (PRD-683 P2-A, Decision 3) — the BRANCH-CANONICAL pull-request
 * resolution: which single PR speaks for a branch.
 *
 * One of the TWO sanctioned PR populations (the other is the org-merged
 * population in `apps/api/lib/pull-request-population.ts`). Anything that
 * answers "this branch's PR" — the projection read's checks attach, the
 * profile's per-branch landing dedupe, the coverage donut's has-a-PR split —
 * resolves through here or carries a documented exemption in the
 * `pull-request-population-declaration` source gate's allowlist.
 *
 * Definition (PRD-683 D1): the promotion pointer
 * (`BranchDetail.currentPullRequestDetailId`, maintained by
 * `promoteBranchCurrentPullRequest` with the webhook-wins guards), with
 * owned-set fallback while the pointer is absent or still an empty stub — the
 * heal window the targeted tier-2 sync closes. The owned-set order is the
 * shared deterministic selector (`selectBranchAssociatedPullRequests`), so
 * cloud and desktop fall back identically.
 *
 * When a valid pointer and the owned-set selection disagree, the arbitration is
 * ELIGIBILITY-FIRST (operator ruling 2026-09-01, ISS-8522): a live fact-carrying
 * PR outranks a factless stub or an older terminal PR, and only WITHIN one
 * suitability tier does the provider-authoritative row win. Provider authority
 * is a tie-breaker among suitable candidates, not permission to regress to
 * empty or obsolete data — ranking on authority alone handed a branch with a
 * live pointer to an older MERGED sibling, and let a factless provider stub
 * displace a pointer carrying real synced facts (PR #6400 reviews).
 *
 * The ruling ranks a live fact-carrying row above BOTH of the others but does
 * not order those two against each other; ranking terminal above factless is
 * this module's reading, on the grounds that an obsolete row still states a
 * number, a title and an outcome while a stub states nothing renderable.
 *
 * A tier tie the authority term cannot break is NOT resolved: the existing
 * canonical projection is preserved and the ambiguity is reported
 * ({@link reportBranchCanonicalPullRequestAmbiguity}) so the next read re-derives
 * once authority resolves. The pointer/owned-set disagreement itself stays a
 * separate repair signal ({@link reportBranchCanonicalPointerDivergence}).
 */

import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { hasObservedPullRequestEvidence } from "@repo/api/src/types/pull-request-lifecycle-observation";
import type { Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { isEmptyPullRequestStub } from "./pull-request-current-promotion";
import { isProviderAuthoritativePullRequest } from "./pull-request-provider-authority";

/** How the canonical PR was resolved. */
export const BranchCanonicalPullRequestSource = {
  Pointer: "pointer",
  OwnedSet: "owned_set",
  None: "none",
} as const;
export type BranchCanonicalPullRequestSource =
  (typeof BranchCanonicalPullRequestSource)[keyof typeof BranchCanonicalPullRequestSource];

/** The detail fields the resolution needs (a subset of any PR-detail select). */
export type BranchCanonicalPullRequestDetail = {
  id: string;
  fetchMechanism: string | null;
  githubId: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  prState: string | null;
  isDraft: boolean | null;
  title: string | null;
  reviewDecision: string | null;
  githubCreatedAt: Date | string | null;
  closedAt: Date | string | null;
  mergedAt: Date | string | null;
};

export type BranchCanonicalPullRequestResolution = {
  /** The canonical PR-detail row id, or null when the branch has none. */
  id: string | null;
  /**
   * The VALID pointer's row id, or null when the branch has no usable pointer.
   * Reported as-is: {@link id} may now name the owned-set row instead, so a
   * monitor that read the winner would mislabel the pointer it is repairing.
   */
  pointerId: string | null;
  source: BranchCanonicalPullRequestSource;
  /**
   * True when a VALID pointer and a non-null owned-set selection named
   * different rows, whichever of them won. The caller should report it (see
   * {@link reportBranchCanonicalPointerDivergence}).
   */
  pointerDivergedFromOwnedSet: boolean;
  /**
   * True when the two disagreeing candidates tied on suitability AND on
   * provider authority. The existing projection was preserved; the caller
   * should report it (see {@link reportBranchCanonicalPullRequestAmbiguity}).
   */
  ambiguous: boolean;
};

/**
 * Resolve the canonical PR id. `ownedSetSelectedId` is the shared selector's
 * `collection.selectedId` mapped back to a detail row id (null when the
 * selector chose none — ambiguous, or no valid candidates).
 */
export function resolveBranchCanonicalPullRequestId(row: {
  currentPullRequestDetailId: string | null;
  pullRequestDetails: readonly BranchCanonicalPullRequestDetail[];
  ownedSetSelectedId: string | null;
}): BranchCanonicalPullRequestResolution {
  const pointed = row.currentPullRequestDetailId
    ? (row.pullRequestDetails.find(
        (detail) => detail.id === row.currentPullRequestDetailId
      ) ?? null)
    : null;
  const pointerIsValid = pointed !== null && !isEmptyPullRequestStub(pointed);
  if (!pointerIsValid) {
    return {
      id: row.ownedSetSelectedId,
      pointerId: null,
      source:
        row.ownedSetSelectedId === null
          ? BranchCanonicalPullRequestSource.None
          : BranchCanonicalPullRequestSource.OwnedSet,
      pointerDivergedFromOwnedSet: false,
      ambiguous: false,
    };
  }
  const diverged =
    row.ownedSetSelectedId !== null && row.ownedSetSelectedId !== pointed.id;
  const contender = diverged
    ? (row.pullRequestDetails.find(
        (detail) => detail.id === row.ownedSetSelectedId
      ) ?? null)
    : null;
  const winner = contender
    ? arbitrateBranchCanonicalCandidates(pointed, contender)
    : pointed;
  return {
    id: (winner ?? pointed).id,
    pointerId: pointed.id,
    source:
      winner === contender && contender !== null
        ? BranchCanonicalPullRequestSource.OwnedSet
        : BranchCanonicalPullRequestSource.Pointer,
    pointerDivergedFromOwnedSet: diverged,
    ambiguous: winner === null,
  };
}

/**
 * Eligibility first, provider authority only as the within-tier tie-break; a
 * tie neither term breaks returns null so the caller preserves what it had.
 */
function arbitrateBranchCanonicalCandidates(
  pointed: BranchCanonicalPullRequestDetail,
  contender: BranchCanonicalPullRequestDetail
): BranchCanonicalPullRequestDetail | null {
  const pointedSuitability = branchCanonicalSuitability(pointed);
  const contenderSuitability = branchCanonicalSuitability(contender);
  if (pointedSuitability !== contenderSuitability) {
    return pointedSuitability > contenderSuitability ? pointed : contender;
  }
  const pointedIsAuthoritative = isProviderAuthoritativePullRequest(pointed);
  const contenderIsAuthoritative =
    isProviderAuthoritativePullRequest(contender);
  if (pointedIsAuthoritative === contenderIsAuthoritative) {
    return null;
  }
  return contenderIsAuthoritative ? contender : pointed;
}

function branchCanonicalSuitability(
  detail: BranchCanonicalPullRequestDetail
): number {
  if (!hasObservedPullRequestEvidence(detail)) {
    return BranchCanonicalSuitability.Factless;
  }
  return isTerminalPullRequestDetail(detail)
    ? BranchCanonicalSuitability.Terminal
    : BranchCanonicalSuitability.Live;
}

function isTerminalPullRequestDetail(
  detail: BranchCanonicalPullRequestDetail
): boolean {
  return (
    detail.mergedAt != null ||
    detail.closedAt != null ||
    detail.prState === GitHubPRState.Merged ||
    detail.prState === GitHubPRState.Closed
  );
}

/**
 * Pointer/owned-set disagreement is a data-repair signal (a stale or
 * webhook-superseded pointer), not something a read may silently resolve.
 * Server-side structured log on the reconciler observability lane (ISS-7875);
 * `event` is the stable monitor key.
 */
export function reportBranchCanonicalPointerDivergence(input: {
  organizationId: string;
  branchArtifactId: string;
  pointerId: string;
  ownedSetSelectedId: string;
}): void {
  if (
    !admitCanonicalDivergenceEmission(
      BranchCanonicalDivergenceEvent.PointerDivergence,
      input
    )
  ) {
    return;
  }
  log.warn("branch canonical pointer diverged from owned-set selection", {
    event: BranchCanonicalDivergenceEvent.PointerDivergence,
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    pointerId: input.pointerId,
    ownedSetSelectedId: input.ownedSetSelectedId,
  });
}

/**
 * "This branch has a PR at all" — the coverage donut's numerator (ISS-8153).
 * Keyed on OWNED ROWS, never the pointer: the schema does not constrain
 * `currentPullRequestDetailId` to the owning branch, and an absent pointer
 * (the pre-promotion tier-2 shape) must not read as "no PR" when PR rows
 * exist. Same distrust `branchPushEvidenceWhere` documents for its PR arm.
 */
export function branchHasAnyPullRequestWhere(): Prisma.BranchDetailWhereInput {
  return { artifact: { is: { pullRequestDetails: { some: {} } } } };
}

/** Exact negation of {@link branchHasAnyPullRequestWhere} for the no-PR bucket. */
export function branchHasNoPullRequestWhere(): Prisma.BranchDetailWhereInput {
  return { artifact: { is: { pullRequestDetails: { none: {} } } } };
}

/**
 * A tie the ranking could not break is a read the reconciler must revisit, not
 * a coin flip: reported so the preserved projection is visible while authority
 * is still resolving. `event` is the stable monitor key.
 */
export function reportBranchCanonicalPullRequestAmbiguity(input: {
  organizationId: string;
  branchArtifactId: string;
  pointerId: string;
  ownedSetSelectedId: string;
}): void {
  if (
    !admitCanonicalDivergenceEmission(
      BranchCanonicalDivergenceEvent.PullRequestAmbiguity,
      input
    )
  ) {
    return;
  }
  log.warn("branch canonical pull request selection is ambiguous", {
    event: BranchCanonicalDivergenceEvent.PullRequestAmbiguity,
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    pointerId: input.pointerId,
    ownedSetSelectedId: input.ownedSetSelectedId,
  });
}

/**
 * Ordered suitability tiers. A candidate no producer ever observed carries no
 * facts to render, and a terminal PR is obsolete while a live one exists, so
 * both rank below a live fact-carrying row whatever wrote them.
 */
const BranchCanonicalSuitability = {
  Factless: 0,
  Terminal: 1,
  Live: 2,
} as const;

/**
 * Whether a PR-detail row belongs to the BRANCH'S OWN repository. The canonical
 * population keys on `branchArtifactId` alone, which the schema does not
 * constrain to agree with the branch's repository — so a lane that spends a
 * credential on `<branch repo>#<number>`, or writes the resolved row's facts
 * onto the branch, re-checks ownership here instead of trusting the resolution.
 *
 * GitHub's own repository id is the identity. It is stable across a reinstall
 * (which is what makes it fix the split), and it survives a rename, which a
 * name compare does not. A name compare also ACCEPTS a conflict it should
 * reject: two `acme/web` rows that are genuinely different repositories carry
 * different provider ids, and accepting that pair here stamps retry/provenance
 * on the wrong PR before the downstream `githubId` check bails out. So the
 * provider id decides whenever both sides have one.
 *
 * The name arm remains, and is load-bearing rather than vestigial: a repo-less
 * row (PLN-1775 M7) carries no installation relation and so no provider id at
 * all, and it is identified by its own normalized `repositoryFullName` column
 * through {@link repositoryIdentityFullName}. Two rows with no provider id
 * between them are compared by name exactly as before.
 */
export function branchOwnsPullRequestDetail(
  branch: RepositoryIdentityRow,
  detail: RepositoryIdentityRow
): boolean {
  const branchProviderId = branch.repository?.githubRepoId ?? null;
  const detailProviderId = detail.repository?.githubRepoId ?? null;
  if (branchProviderId && detailProviderId) {
    return branchProviderId === detailProviderId;
  }
  const branchFullName = repositoryIdentityFullName(branch);
  const detailFullName = repositoryIdentityFullName(detail);
  return Boolean(
    branchFullName && detailFullName && branchFullName === detailFullName
  );
}

/**
 * A row carrying a repository identity: the installation relation when the repo
 * is App-backed, the denormalized column when it is repo-less (PLN-1775 M7).
 * `githubRepoId` is optional on the relation because not every select hydrates
 * it; an absent one falls the comparison back to the name arm rather than
 * silently reading as "no match".
 */
type RepositoryIdentityRow = {
  repositoryFullName?: string | null;
  repository?: { fullName: string; githubRepoId?: string | null } | null;
};

/** Provider-backed repository identity used by guarded tombstoned writes. */
export type TombstonedRepositoryIdentity = {
  fullName: string;
  githubRepoId?: string | null;
};

/**
 * A row's repository identity as a normalized `owner/repo`, preferring the
 * installation relation (the canonical name GitHub itself reports) over the
 * denormalized column, or `null` when the row names no repository at all.
 */
function repositoryIdentityFullName(row: RepositoryIdentityRow): string | null {
  const fullName = row.repository?.fullName ?? row.repositoryFullName;
  return fullName ? normalizeRepoFullName(fullName) : null;
}

/**
 * The repository term the tombstoned-refresh lane's guarded writes key on.
 *
 * GitHub's provider repository id is authoritative across reinstall and rename
 * splits. The normalized name remains the compatibility identity when the
 * provider id is absent. The independent tombstone term keeps user OAuth writes
 * off live App-covered repositories.
 *
 */
export function tombstonedRepositoryWhere(
  repository: TombstonedRepositoryIdentity
): Prisma.GitHubInstallationRepositoryWhereInput {
  if (repository.githubRepoId) {
    return {
      ...TOMBSTONED_REPOSITORY_WHERE,
      githubRepoId: repository.githubRepoId,
    };
  }
  return {
    ...TOMBSTONED_REPOSITORY_WHERE,
    fullName: {
      equals: normalizeRepoFullName(repository.fullName),
      mode: "insensitive",
    },
  };
}

/**
 * The tombstone half on its own, for the one site that has no repository name
 * to key on. Shared so the two spellings of "tombstoned" on this lane cannot
 * drift apart the next time the definition changes.
 */
export const TOMBSTONED_REPOSITORY_WHERE = {
  removedAt: { not: null },
} as const satisfies Prisma.GitHubInstallationRepositoryWhereInput;

/**
 * The candidate set for any question of the form "which of this branch's PRs …"
 * — LOC roll-ups, lifecycle evidence, attribution refs, cohort outcomes — as
 * opposed to {@link resolveBranchCanonicalPullRequestId}, which picks the ONE
 * row that speaks for the branch.
 *
 * The population is the promotion pointer followed by the owned set
 * (`Artifact.pullRequestDetails`, the `BranchPullRequests` relation keyed on
 * `branchArtifactId`), in that order. Both arms are load-bearing because
 * nothing at the SCHEMA level ties them: `BranchDetail.currentPullRequestDetailId`
 * is a plain nullable FK to `PullRequestDetail.id` (`onDelete: SetNull`) with no
 * term requiring the referenced row's `branchArtifactId` to be the pointing
 * branch — the same gap {@link branchHasAnyPullRequestWhere} already refuses to
 * trust. A pointer CAN therefore name a row absent from the owned set beside it,
 * and dropping the arm would silently lose it.
 *
 * Every writer that sets a NON-NULL pointer re-checks that ownership itself
 * today: `promoteBranchCurrentPullRequest`, `branch-service.ts` and
 * `github-projection-writer.ts` throw when the row's `branchArtifactId` is not
 * the branch's; `service/repository-artifact-relink.ts` validates the pointer
 * before retaining it, adopts only a same-branch number collision, and nulls it
 * when its final scoped update misses. `pull-request-branch-relink.ts` and
 * `pull-request-provider-identity.ts` only ever null it. That is a convention
 * held at every call site, not a constraint this read may assume — keeping the
 * inventory true is ISS-8523's audit before the column can go.
 *
 * This exists so a consumer never spells that union itself. Seven call sites
 * had each written their own copy of `[pointer, ...owned]`, which is what made
 * "no read resolves the pointer directly" a grep rather than a fact: the read
 * lives here, in the module that owns the arbitration, and a consumer passes
 * the branch row instead of reaching into it. All seven now route through here.
 *
 * Order is preserved and duplicates are NOT folded: the pointer row is usually
 * also in the owned set, so a caller that accumulates rather than `find`s sees
 * it twice. Every current caller either takes the first match or dedupes on a
 * PR identity downstream. Folding here would need an identity every caller's
 * select carries, and the narrowest of them selects no `id` at all.
 *
 * An ABSENT pointer contributes no element, so the length is the candidate
 * count and a branch with no PRs yields `[]`. The union this replaced left a
 * `null` in the first slot, which every caller already skipped — dropping it is
 * behaviour-identical at all seven and keeps `| null` out of the element type,
 * so the eighth caller is corrected by `tsc` rather than by a hand-written
 * guard it might forget.
 */
export function branchCandidatePullRequests<
  Pointer extends object,
  Owned extends object,
>(
  branch: { currentPullRequestDetail: Pointer | null } | null | undefined,
  ownedPullRequestDetails: readonly Owned[] | null | undefined
): readonly (Pointer | Owned)[] {
  const pointer = branch?.currentPullRequestDetail;
  return [...(pointer ? [pointer] : []), ...(ownedPullRequestDetails ?? [])];
}

/**
 * ISS-8902 — the two monitored canonical-divergence signals above, as ONE
 * vocabulary. Exported so a suite pins the monitor keys by reference instead of
 * retyping the literal a Datadog query depends on.
 */
export const BranchCanonicalDivergenceEvent = {
  PointerDivergence: "branch_canonical_pointer_divergence",
  PullRequestAmbiguity: "branch_canonical_pull_request_ambiguity",
} as const;
export type BranchCanonicalDivergenceEvent =
  (typeof BranchCanonicalDivergenceEvent)[keyof typeof BranchCanonicalDivergenceEvent];

/**
 * Aggregate rollup names, one per signal. A separate event name rather than a
 * field on the detail record, so a monitor counting detail records is never
 * inflated by a rollup that stands for many (the `link-tree-oversize-log.ts`
 * precedent).
 *
 * An exhaustive `Record` over the vocabulary, not a lookup with a fallback: a
 * third signal added to {@link BranchCanonicalDivergenceEvent} fails `tsc` here
 * rather than silently emitting its suppressed count under no name at all.
 */
const CANONICAL_DIVERGENCE_SUPPRESSED_EVENT: Record<
  BranchCanonicalDivergenceEvent,
  string
> = {
  [BranchCanonicalDivergenceEvent.PointerDivergence]:
    "branch_canonical_pointer_divergence_suppressed",
  [BranchCanonicalDivergenceEvent.PullRequestAmbiguity]:
    "branch_canonical_pull_request_ambiguity_suppressed",
};

/**
 * Aggregate rollup names for occurrences the ORG-WIDE ceiling refused, one per
 * signal. Deliberately distinct from
 * {@link CANONICAL_DIVERGENCE_SUPPRESSED_EVENT}: a per-branch rollup says "this
 * branch kept diverging", an org rollup says "this ORG produced more distinct
 * diverging branches than the ceiling reports in one window". A monitor that
 * could not tell them apart would read keyspace pressure as branch churn.
 */
const CANONICAL_DIVERGENCE_ORG_SUPPRESSED_EVENT: Record<
  BranchCanonicalDivergenceEvent,
  string
> = {
  [BranchCanonicalDivergenceEvent.PointerDivergence]:
    "branch_canonical_pointer_divergence_org_budget_suppressed",
  [BranchCanonicalDivergenceEvent.PullRequestAmbiguity]:
    "branch_canonical_pull_request_ambiguity_org_budget_suppressed",
};

type CanonicalDivergenceEmissionContext = {
  event: BranchCanonicalDivergenceEvent;
  organizationId: string;
  branchArtifactId: string;
};

type CanonicalDivergenceOrgEmissionContext = {
  event: BranchCanonicalDivergenceEvent;
  organizationId: string;
};

/**
 * How many DISTINCT branches one (org, signal) may report in a window before
 * the rest are folded into an org rollup.
 *
 * The per-branch throttle below bounds repeat polls of ONE branch; it does not
 * bound the number of branches. An authenticated caller reading many diverging
 * branches therefore still drove an unbounded warn stream — each fresh
 * `branchArtifactId` opened its own budget, and past the LRU cap eviction
 * recycled keys so previously visited branches emitted again inside the same
 * window (#7204 review). `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * asks for the bound per org, not only per correlation key.
 *
 * 20 is a reporting ceiling, not a capacity estimate: an operator reading 20
 * fully-detailed diverging branches per minute has enough to act on, and the
 * count of everything past it survives in the rollup.
 */
const MAX_CANONICAL_DIVERGENCE_DETAILS_PER_ORG_WINDOW = 20;

/**
 * Both signals fire from `projectCloudBranchDetail`, once per branch-detail
 * READ, for as long as the divergence persists — so a client polling one branch
 * drove one or two `log.warn`s per poll with nothing bounding them
 * (`apps/api/AGENTS.md`, "Emission and Abuse Control").
 *
 * ONE throttle covers BOTH: the ambiguity signal is nested inside the divergence
 * condition and can never fire alone, so bounding only the newer one would have
 * left the identical stream in place. The event name is part of the KEY rather
 * than sharing one budget, because a suppressed ambiguity is a different fact
 * from a suppressed divergence and the busier signal must not starve the other.
 *
 * Bounded growth, per the root `AGENTS.md` rule on in-memory maps keyed by
 * external input: the shared primitive holds a hard `maxEntries` LRU cap
 * (10,000) and flushes an evicted key's pending count through `onFlush` rather
 * than dropping it, plus the expiry drain below. Process-local and best-effort
 * on serverless, like every other emission bound in this app.
 *
 * WHAT AN OPERATOR STILL SEES under sustained divergence: one FULL detail record
 * per (org, branch, signal) per minute — naming the branch, the pointer and the
 * owned-set selection, exactly as before — plus a rollup carrying the count the
 * window suppressed. The occurrence COUNT is never discarded:
 * `count(detail) + sum(suppressed)` still recovers it, so a monitor keyed on the
 * detail event keeps firing while its rate stops tracking client poll frequency.
 *
 * POINTER IDENTITY, HOWEVER, IS SAMPLED ONCE PER WINDOW. `pointerId` and
 * `ownedSetSelectedId` are reported but deliberately NOT part of the key, so if
 * the pointer moves mid-window the second divergence — a genuinely different
 * fact — is folded into the count and the surviving record names the FIRST
 * pointer. A reader must not treat one window's record as the complete set of
 * pointers that diverged. Keying on the pointer pair instead would restore that
 * identity at the cost of the bound itself: a flapping pointer is exactly the
 * shape that would then emit per-poll again, which is what this exists to stop.
 */
const canonicalDivergenceThrottle =
  new FixedWindowEmissionThrottle<CanonicalDivergenceEmissionContext>({
    onFlush: (context, suppressedCount, cause) =>
      logCanonicalDivergenceSuppressed(context, suppressedCount, cause),
  });

/**
 * The coarse ORG-WIDE ceiling, spent only by occurrences the per-branch throttle
 * already admitted — so one branch's poll loop cannot spend the org's budget and
 * silence every other diverging branch in it. That ordering is why this is not
 * simply checked first: the per-branch throttle is a CORRELATION key (one record
 * per branch per window) and this is a SPENDING budget over the distinct
 * branches that survive it, the coarse-key pattern
 * `FixedWindowEmissionThrottle` documents for `maxPerWindow` above 1.
 *
 * Keyed on `(signal, org)`, which is bounded by the org count rather than by
 * anything a caller can mint, so this map cannot be churned by branch ids the
 * way the per-branch one can.
 */
const canonicalDivergenceOrgThrottle =
  new FixedWindowEmissionThrottle<CanonicalDivergenceOrgEmissionContext>({
    maxPerWindow: MAX_CANONICAL_DIVERGENCE_DETAILS_PER_ORG_WINDOW,
    onFlush: (context, suppressedCount, cause) =>
      logCanonicalDivergenceOrgSuppressed(context, suppressedCount, cause),
  });

/**
 * Flush and drop keys whose window is certainly over. Call it from a path every
 * branch-detail read runs — NOT only a diverging one — so a burst on one branch
 * followed by quiet still reaches its rollup instead of sitting in memory until
 * that same branch diverges again. O(1) while nothing has expired.
 *
 * Exported for that caller and for suite isolation; there is deliberately no
 * timer, because a frozen serverless instance would never fire one.
 */
export function drainBranchCanonicalDivergenceEmissions(now: number): number {
  // BOTH budgets: the org ceiling holds pending counts exactly as the per-branch
  // one does, so draining only the per-branch throttle would leave an org's
  // final window pending until that org next diverged.
  return (
    canonicalDivergenceThrottle.drainExpired(now) +
    canonicalDivergenceOrgThrottle.drainExpired(now)
  );
}

/**
 * Drop all throttle state WITHOUT flushing. A TEST-ISOLATION affordance only:
 * this budget is module-level state that would otherwise carry from one case
 * into the next and make a suite order-dependent (`vi.clearAllMocks()` resets
 * the log spy, never this). Production code must not call it — it discards
 * pending suppressed counts instead of flushing them.
 */
export function resetBranchCanonicalDivergenceThrottle(): void {
  canonicalDivergenceThrottle.clear();
  canonicalDivergenceOrgThrottle.clear();
}

/**
 * Whether THIS occurrence emits its own detail record. The caller has already
 * decided the underlying condition holds and acts only on this answer, so a
 * throttling bug can never change the projection being reported on.
 */
function admitCanonicalDivergenceEmission(
  event: BranchCanonicalDivergenceEvent,
  input: { organizationId: string; branchArtifactId: string }
): boolean {
  const context: CanonicalDivergenceEmissionContext = {
    event,
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
  };
  // NUL-joined: no key part can contain it, so two different triples cannot
  // collide into one budget through a separator appearing inside an id.
  const key = `${event}\u0000${input.organizationId}\u0000${input.branchArtifactId}`;
  // ONE clock reading for both budgets: two `Date.now()` calls could straddle a
  // window boundary and let an occurrence spend a fresh per-branch window
  // against the previous org window.
  const now = Date.now();
  const decision = canonicalDivergenceThrottle.record(key, context, now);
  if (decision.flushedSuppressedCount > 0) {
    logCanonicalDivergenceSuppressed(
      context,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return false;
  }
  return admitCanonicalDivergenceOrgBudget(event, input.organizationId, now);
}

/**
 * Whether the ORG's window still has budget for one more DETAIL record. Reached
 * only by occurrences the per-branch throttle already admitted, so the ceiling
 * is spent by DISTINCT branches rather than by one branch's poll loop — which is
 * what keeps a single hot branch from silencing every other diverging branch in
 * the same org.
 */
function admitCanonicalDivergenceOrgBudget(
  event: BranchCanonicalDivergenceEvent,
  organizationId: string,
  now: number
): boolean {
  const context: CanonicalDivergenceOrgEmissionContext = {
    event,
    organizationId,
  };
  const decision = canonicalDivergenceOrgThrottle.record(
    orgDivergenceKey(event, organizationId),
    context,
    now
  );
  if (decision.flushedSuppressedCount > 0) {
    logCanonicalDivergenceOrgSuppressed(
      context,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  return decision.emit;
}

/**
 * One aggregate rollup for occurrences a window suppressed. `flushedBy` says
 * what materialised it, because a query that cannot tell an expiry drain from an
 * LRU eviction cannot tell a quiet branch from keyspace pressure.
 */
/**
 * One aggregate rollup for detail records the ORG ceiling refused. Carries no
 * `branchArtifactId` on purpose: the whole point of this bound is that the
 * branches past the ceiling were never individually reported, so naming one of
 * them would imply the rest were that same branch.
 */
function logCanonicalDivergenceOrgSuppressed(
  context: CanonicalDivergenceOrgEmissionContext,
  suppressed: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(CANONICAL_DIVERGENCE_ORG_SUPPRESSED_EVENT[context.event], {
    event: CANONICAL_DIVERGENCE_ORG_SUPPRESSED_EVENT[context.event],
    organizationId: context.organizationId,
    suppressed,
    flushedBy,
  });
}

function logCanonicalDivergenceSuppressed(
  context: CanonicalDivergenceEmissionContext,
  suppressed: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(CANONICAL_DIVERGENCE_SUPPRESSED_EVENT[context.event], {
    event: CANONICAL_DIVERGENCE_SUPPRESSED_EVENT[context.event],
    organizationId: context.organizationId,
    branchArtifactId: context.branchArtifactId,
    suppressed,
    flushedBy,
  });
}

/**
 * The org ceiling's key. NUL-joined for the same reason the per-branch key is:
 * no key part can contain it, so two different pairs cannot collide into one
 * budget through a separator appearing inside an id.
 */
function orgDivergenceKey(
  event: BranchCanonicalDivergenceEvent,
  organizationId: string
): string {
  return `${event}\u0000${organizationId}`;
}

/**
 * {@link branchOwnsPullRequestDetail} as a Prisma predicate, for a read that must
 * narrow the candidate list IN THE QUERY rather than after it.
 *
 * It lives beside the in-memory twin because the two have to answer identically
 * ON THE REPOSITORY AXIS: a `where` stricter THERE silently drops rows the helper
 * calls owned, which is the same silent under-read a scoped candidate list exists
 * to prevent. The asymmetric case is the one that matters —
 * `PullRequestDetail.repositoryId` is nullable enrichment (PRD-510 D2), so an
 * App-backed branch can own a desktop-written row that no installation has
 * adopted yet; matching the branch's surrogate id alone would discard exactly the
 * PR the read is looking for. A repo-less branch compares on the normalized full
 * name, the identity every repo-less writer persists.
 *
 * `organizationId` is a SECOND, independent axis, and it is deliberately absent
 * from the in-memory twin rather than missing from it. The twin classifies rows a
 * caller already holds, which an org-scoped read fetched; this predicate IS the
 * fetch, and it reaches `PullRequestDetail` through the `BranchPullRequests`
 * relation, which the schema keys on `branchArtifactId` ALONE. Until #7216
 * (ISS-10170 — the composite foreign key ISS-10288 asked for) nothing
 * constrained that row's own denormalized `organizationId` to agree with its
 * branch artifact's, so a live row written under another organization, carrying
 * this branch's artifact id and the same repository identity, joined here and —
 * live where the branch's own PR is terminal — won the canonical arbitration,
 * putting a foreign organization's PR URL and number into the caller's tracked
 * targets. `pull_request_detail_branch_artifact_tenant_fkey` now refuses that
 * row at the write, so through this relation the org term excludes nothing the
 * current database would let exist. It stays on BOTH arms regardless: it is the
 * repo's standing rule that every read touching per-tenant data carries
 * `organizationId` in the `where`, it keeps migration-window or version-skewed
 * databases guarded, and a predicate that is only correct while a constraint
 * holds is what a dropped constraint turns into a leak.
 */
export function branchOwnedPullRequestWhere(branch: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
}): Prisma.PullRequestDetailWhereInput {
  const normalizedFullName = normalizeRepoFullName(branch.repositoryFullName);
  if (branch.repositoryId) {
    return {
      organizationId: branch.organizationId,
      OR: [
        { repositoryId: branch.repositoryId },
        { repositoryId: null, repositoryFullName: normalizedFullName },
      ],
    };
  }
  return {
    organizationId: branch.organizationId,
    repositoryFullName: normalizedFullName,
  };
}
