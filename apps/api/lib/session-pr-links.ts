// Shared building blocks for the session→link readers
// (agent-session-attribution.ts and agent-session-delivery-metrics.ts), so the
// link predicates — and the merged-PR classification and dedup identity built on
// them — live here once instead of being copy-pasted per reader.
//
// The two readers no longer share a traversal, because they need different
// populations. Attribution is genuinely PER-SESSION (it splits each session's
// cost across its targets), so it reads the links and their targets as sets and
// stitches them per session — see `agent-session-attribution-read.ts`. The
// delivery cards need only the DISTINCT merged PRs, so ISS-6028 moved them to
// `findMergedPrsLinkedToSessions`, which reads the PR side and semi-joins BACK
// through the same links rather than draining the org's session history to
// rediscover them.
//
// ISS-7905: they no longer share ONE predicate either, and the split is the
// point rather than drift. `sessionPrLinkFromSessions` selects the session→PR
// arms and backs attribution and the cost split; `deliveryPrLinkFromSessions`
// selects the wider ISS-8153 session-linked arms and backs the delivery cards.
// Which one a reader composes is a statement about what its number MEANS, so
// pick it deliberately — see both docstrings.

import type { DeliveryWindow } from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactRefMethod,
  allowsUniqueBranchPrFallback,
  classifySessionPrMetadata,
  commandDerivedSessionPrRefsFromMetadata,
  PROSE_MENTION_REF_METHODS,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
  SessionPrMetadataClassificationKind,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import {
  declaresSessionBranchLinkKind,
  sessionPrIdentityMetadataSchema,
} from "@repo/api/src/types/session-pr-link-metadata";
import { Prisma, withDb } from "@repo/database";
import type { LimitFunction } from "p-limit";
import { readInIdChunks } from "./session-pr-links-chunking";

/**
 * ISS-5823 — WHY a caller is selecting session→PR links, which is the only thing
 * that decides whether prose-derived evidence belongs in its population.
 *
 * Every reader must name one. The kind predicate is a function rather than a
 * constant precisely so the choice is stated at the call site: a prose-derived
 * link is a WEAKER signal than a command-derived one, and the failure mode this
 * ticket exists to prevent is a reader silently inheriting it.
 */
export const SessionPrLinkAudience = {
  /**
   * The population behind a number a user reads, or an authorization decision.
   * Prose-derived links are EXCLUDED — a model typing "PR #4710" in a sentence
   * must not move a merged-PR count, a median PR size, a LOC-per-dollar, a cost
   * divisor, or a "has PR" facet, and must not vouch for a GitHub write.
   */
  Metric: "metric",
  /**
   * A read ABOUT the links themselves — the ingest lanes that own these rows and
   * the session-detail edge that carries them. Prose-derived links are INCLUDED,
   * because a lane that cannot see a row it must manage would orphan it.
   */
  Evidence: "evidence",
} as const;
export type SessionPrLinkAudience =
  (typeof SessionPrLinkAudience)[keyof typeof SessionPrLinkAudience];

export const MergedPrBranchAdmissionKind = {
  ExactIdentity: "exact_identity",
  LegacyUniqueBranch: "legacy_unique_branch",
  TierTwoUniqueBranch: "tier_two_unique_branch",
} as const;
export type MergedPrBranchAdmissionKind =
  (typeof MergedPrBranchAdmissionKind)[keyof typeof MergedPrBranchAdmissionKind];

/**
 * The canonical `sourceLinks`/`ArtifactLink` WHERE predicate that selects a
 * session→PR link, narrowed to what `audience` admits. Exported so the
 * attribution and delivery-metrics readers share ONE literal instead of each
 * re-spelling it (previously duplicated four times).
 *
 * The link-level kind is only half the gate. A link whose refs are ALL prose is
 * written under `SessionPrProse` and excluded here; a link that mixes a
 * command-derived ref with a prose one keeps the strong kind and IS returned, so
 * a `Metric` reader must additionally take its identities from
 * {@link commandDerivedSessionPrRefsFromMetadata} rather than from
 * `sessionPrRefsFromMetadata`.
 */
export function sessionPrLinkKindWhere(
  audience: SessionPrLinkAudience
): Prisma.ArtifactLinkWhereInput {
  const strong: Prisma.ArtifactLinkWhereInput[] = [
    {
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionPr,
      },
    },
    {
      metadata: {
        path: ["linkKinds"],
        array_contains: [SessionArtifactLinkKind.SessionPrSet],
      },
    },
  ];
  if (audience === SessionPrLinkAudience.Metric) {
    return { OR: strong };
  }
  return {
    OR: [
      ...strong,
      {
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionPrProse,
        },
      },
      // A link that ALSO carries independent branch evidence keeps
      // `linkKind: session_branch` and states its weak PR tier in `linkKinds`,
      // so the scalar test alone would miss it.
      {
        metadata: {
          path: ["linkKinds"],
          array_contains: [SessionArtifactLinkKind.SessionPrProse],
        },
      },
    ],
  };
}

/** {@link sessionPrLinkKindWhere} plus the RELATES_TO edge type. */
export function sessionPrLinkWhere(
  audience: SessionPrLinkAudience
): Prisma.ArtifactLinkWhereInput {
  return {
    linkType: LinkType.RelatesTo,
    ...sessionPrLinkKindWhere(audience),
  };
}

/**
 * The desktop / installation-free lane's at-rest shape: a session→BRANCH link
 * that is not prose-derived (ISS-7721).
 *
 * ONE spelling, consumed by both halves of the ISS-8153 org-merged population —
 * `orgMergedPullRequestWhere` (Insights Delivery, profile "PRs landed") and the
 * Sessions delivery cards below. It lived in `pull-request-population.ts` and
 * moved here so the module the source gate names as the owner of the
 * session-link predicate owns all of it; keeping two copies is how the two
 * surfaces came to admit different link shapes in the first place.
 *
 * Keep in lockstep with the reconciler's `sessionBranchPushLinkSql` and with
 * `orgMergedPullRequestMembershipSql`'s third arm — this is the evidence tier
 * that authorizes a tier-2 fetch, so a row it verifies cannot then be invisible
 * to the count that verification exists to serve.
 */
export function sessionBranchNonProseLinkArm(): Prisma.ArtifactLinkWhereInput {
  return {
    AND: [
      {
        OR: [
          {
            metadata: {
              path: ["linkKind"],
              equals: SessionArtifactLinkKind.SessionBranch,
            },
          },
          {
            metadata: {
              path: ["linkKinds"],
              array_contains: [SessionArtifactLinkKind.SessionBranch],
            },
          },
        ],
      },
      // "Not prose" must ADMIT a link that carries no `method` at all, which is
      // the desktop lane's own at-rest shape and the majority of this arm's
      // population. A bare `NOT` cannot say that: `metadata #> '{method}'` is
      // SQL NULL on an absent key, so `NOT (NULL = 'branch_mention_in_prose')`
      // is NULL and Postgres drops the row — the arm then selected ONLY links
      // that spell a non-prose `method` out, i.e. almost nothing, while every
      // in-memory mirror went on admitting them. The raw-SQL twin
      // `orgMergedPullRequestMembershipSql` guards the same case explicitly
      // (`COALESCE(al.metadata ? 'method', FALSE) AND …`); this is that guard in
      // Prisma, and {@link isNonProseSessionBranchLink} is it in TypeScript.
      // Verified against real Postgres in
      // `agent-session-delivery-metrics.integration.test.ts`, because a mocked
      // reader asserts the predicate's SHAPE and can never catch its semantics.
      {
        OR: [
          { metadata: { path: ["method"], equals: Prisma.AnyNull } },
          {
            NOT: {
              OR: [
                {
                  metadata: {
                    path: ["method"],
                    equals: ArtifactRefMethod.PrMentionInProse,
                  },
                },
                {
                  metadata: {
                    path: ["method"],
                    equals: ArtifactRefMethod.BranchMentionInProse,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * ISS-7905: every link arm the ISS-8153 D1 ruling counts as SESSION-LINKED —
 * the Metric session→PR arms PLUS {@link sessionBranchNonProseLinkArm}.
 *
 * The Sessions "PRs Shipped" card used to select the session→PR arms alone. The
 * PR-detail lane that materializes a PR row from a session's `pull_request`
 * artifact refs deliberately WRITES NO LINK (`persistSessionPullRequestDetails`
 * — "the session↔PR association stays derived via the branch link"), so on that
 * lane the only evidence at rest is the session→branch link. Selecting on the
 * PR arms alone made the card's population empty for those orgs while Insights
 * Delivery, reading the canonical population over the very same rows, rendered a
 * count — a confident `null` beside live evidence, which is the defect.
 */
export function sessionLinkedPopulationArms(): Prisma.ArtifactLinkWhereInput[] {
  return [
    ...(sessionPrLinkKindWhere(SessionPrLinkAudience.Metric).OR ?? []),
    sessionBranchNonProseLinkArm(),
  ];
}

/**
 * The in-memory MIRROR of {@link sessionBranchNonProseLinkArm}, for the
 * admission pass that classifies link metadata already read out of the database.
 * **Keep the two in lockstep** — a predicate that disagrees with its query arm
 * selects a link and then refuses to admit anything through it, which is a
 * silent zero rather than an error.
 *
 * ONE deliberate asymmetry, and it runs in the safe direction: this also fails
 * closed on metadata whose PR-identity shape is INVALID (a `session_pr_set`
 * marker with no array, a malformed `prRefs`). A JSON-path predicate cannot
 * express that classification, so the query arm selects such a link and this
 * refuses it — a NARROWING of an already-selected candidate, never an admission
 * the query did not make. The fail-closed contract on malformed identity
 * metadata predates this arm and is not something branch-level evidence may
 * reopen.
 */
export function isNonProseSessionBranchLink(metadata: unknown): boolean {
  if (
    classifySessionPrMetadata(metadata).kind ===
    SessionPrMetadataClassificationKind.Invalid
  ) {
    return false;
  }
  const parsed = sessionPrIdentityMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return false;
  }
  if (!declaresSessionBranchLinkKind(parsed.data)) {
    return false;
  }
  const method = (parsed.data as { method?: unknown }).method;
  return !(typeof method === "string" && PROSE_MENTION_REF_METHODS.has(method));
}

/**
 * The subset of a PR detail needed to decide whether a session→PR link points at
 * a merged PR and to give that PR a stable dedup identity. A structural minimum
 * so both readers below can pass their own (wider) `GetPayload` PR-detail shape
 * — the delivery-metrics select also carries `additions`/`deletions`, which are
 * irrelevant to identity.
 */
export type MergedPrDetail = {
  number: number | null;
  repositoryId?: string | null;
  prState: string | null;
  mergedAt: Date | null;
  lastVerifiedAt: Date | null;
  repositoryFullName: string | null;
  repository: { fullName: string } | null;
} | null;

/**
 * Is a verified current or historical detail a merged PR? A reused branch's
 * declared PR may no longer be current, so identity admission is separate from
 * lifecycle verification.
 */
export function isMergedPrDetail(detail: MergedPrDetail): boolean {
  return Boolean(
    detail?.lastVerifiedAt &&
      detail.prState === GitHubPRState.Merged &&
      detail.mergedAt !== null
  );
}

/**
 * Prisma mirror of {@link isMergedPrDetail}, for the reader that applies the
 * merged-PR predicate in the DATABASE rather than to hydrated rows (ISS-6028).
 * **Keep the two in lockstep** — a predicate that disagrees with its mirror
 * classifies the same PR as merged in one reader and not the other.
 */
// ISS-8426: this is the lifecycle half of the sanctioned org-merged
// population. Admission still happens against Branch link metadata so Sessions,
// Branches, and Insights can share the same verified/session-linked boundary.
export const MERGED_PR_DETAIL_WHERE = {
  lastVerifiedAt: { not: null },
  prState: GitHubPRState.Merged,
  mergedAt: { not: null },
} as const satisfies Prisma.PullRequestDetailWhereInput;

/**
 * Stable dedup identity for a merged PR linked to a session. Keyed on
 * `repo#number` only when BOTH the repo AND the PR number are known; otherwise it
 * falls back to `branch:${targetId}` (the linked branch artifact id). Requiring a
 * non-null `number` is deliberate: keying on `repo#null` whenever the repo alone
 * is known would collapse every number-less PR from a repo into a single bucket
 * and drop all but one from the count/median (the dedup-by-nullable trap). Shared
 * so both the delivery-metrics and cohort-performance readers dedup identically.
 */
export function mergedPrIdentity(
  detail: MergedPrDetail,
  targetId: string
): string {
  const repo =
    detail?.repository?.fullName ?? detail?.repositoryFullName ?? null;
  return repo && detail?.number != null
    ? sessionPrIdentityKey(repo, detail.number)
    : `branch:${targetId}`;
}

/**
 * The `ArtifactLink` predicate for a session→PR link whose SOURCE session
 * matches `where` — the session→PR arms ONLY.
 *
 * ISS-7905 moved the delivery readers off this onto
 * {@link deliveryPrLinkFromSessions}; what still composes it is the population
 * for which a session→BRANCH link is NOT evidence of a PR: the per-session
 * attribution lens and cost split (`agent-session-attribution-read.ts`, where
 * the branch lane already carries that link and admitting it here would
 * double-count a session's spend), and the reconciler's repo-scoped
 * delivery-coverage tick (`cron/reconcile-pull-requests/`, whose monitored
 * ratio is defined over session→PR links).
 */
export function sessionPrLinkFromSessions(
  where: Prisma.SessionDetailWhereInput
): Prisma.ArtifactLinkWhereInput {
  return {
    // Metric: every caller of this helper feeds an attribution lens, a cost
    // split, or a monitored coverage ratio (ISS-5823).
    ...sessionPrLinkWhere(SessionPrLinkAudience.Metric),
    source: {
      type: ArtifactType.Session,
      session: { is: where },
    },
  };
}

/**
 * ISS-7905: {@link sessionPrLinkFromSessions} for the DELIVERY population — the
 * same source-session filter over {@link sessionLinkedPopulationArms} instead of
 * the session→PR arms alone, so the Sessions cards select the population
 * ISS-8153 sanctioned rather than a strict subset of it.
 *
 * Deliberately a SEPARATE helper rather than a widening of
 * `sessionPrLinkFromSessions`: that one also backs the attribution lens and the
 * per-session cost split, where a session→branch link is already carried by its
 * own branch lane and admitting it here would double-count a session's spend.
 */
export function deliveryPrLinkFromSessions(
  where: Prisma.SessionDetailWhereInput
): Prisma.ArtifactLinkWhereInput {
  return {
    linkType: LinkType.RelatesTo,
    OR: sessionLinkedPopulationArms(),
    source: {
      type: ArtifactType.Session,
      session: { is: where },
    },
  };
}

/**
 * The branch-evidence predicate without a source-session scope, for branch-id
 * anchored reads that resolve source sessions in a second step.
 */
export function sessionBranchPrPopulationLinkFromSessions(
  where: Prisma.SessionDetailWhereInput
): Prisma.ArtifactLinkWhereInput {
  return {
    ...sessionBranchPrPopulationLinkWhere(),
    source: {
      type: ArtifactType.Session,
      session: { is: where },
    },
  };
}

export function sessionBranchPrPopulationLinkWhere(): Prisma.ArtifactLinkWhereInput {
  return {
    linkType: LinkType.RelatesTo,
    ...sessionBranchNonProseLinkArm(),
  };
}

/**
 * Cheap probe: is there at least one session-linked delivery link whose source
 * session matches `where`? The delivery reader calls this before reading so a
 * broad/unfiltered dashboard with no linked evidence never issues the row read
 * at all. The attribution reader needs no separate probe — its own link read is
 * the first thing it issues, and an empty result short-circuits it (ISS-7655).
 */
export async function hasMatchingSessionPrLinks(
  where: Prisma.SessionDetailWhereInput
): Promise<boolean> {
  const link = await withDb((db) =>
    db.artifactLink.findFirst({
      where: deliveryPrLinkFromSessions(where),
      select: { id: true },
    })
  );
  return link !== null;
}

/**
 * The Branch owning each current or historical PR candidate, plus its PR count
 * for unique-only legacy admission.
 */
export type LinkedBranchArtifact = {
  branchArtifact: {
    id: string;
    _count: { pullRequestDetails: number };
  };
};

export type SessionPrBranchAdmission = {
  exactIdentities: Set<string>;
  legacyUniqueFallback: boolean;
  tierTwoUniqueBranchFallback: boolean;
  pullRequestCount: number;
  /**
   * ISS-7905: the branch carries a non-prose session→BRANCH link
   * ({@link isNonProseSessionBranchLink}) — evidence about the BRANCH, which
   * names no PR of its own. Admits this branch's merged PRs only when no link on
   * it declares a command-derived PR identity; see {@link sessionLinkedBranches}.
   */
  branchEvidence: boolean;
};

export type MergedPrLinkRead<Detail> = {
  details: Detail[];
  admissionByBranchId: Map<string, SessionPrBranchAdmission>;
};

/**
 * Every DISTINCT merged PR in `organizationId` linked to the sessions matching
 * `where`, read from the PR side (ISS-6028).
 *
 * This replaces a session-side drain. The delivery scope deliberately carries no
 * session-activity date window, so paging every PR-linked session in the org —
 * each hydrating a `sourceLinks → target → branch → currentPullRequestDetail`
 * relation tree — grew monotonically forever to feed a fixed-size card. Reading
 * the PR side instead semi-joins BACK through the same links and returns
 * O(merged PRs in scope) narrow rows instead of O(PR-linked sessions) hydrated
 * ones. The predicate is unchanged, just relocated: {@link MERGED_PR_DETAIL_WHERE}
 * mirrors `isMergedPrDetail`, while the Branch semi-join admits verified
 * current and historical rows only after the separate identity index matches
 * canonical metadata or a unique-only legacy fallback.
 *
 * Deliberately UNCAPPED (no `take`): `mergedPrCount` and `medianPrSize` are
 * whole-population aggregates over the scope, so a page cap would silently
 * understate both rather than bound anything the caller could report as partial.
 * The population is the card's own answer — one row per merged PR, five scalars
 * wide — not an unbounded scan of a growing session history.
 *
 * ISS-9924: `mergedWithin` bounds the read on `mergedAt` — a range, not a cap.
 * Every consumer counts only PRs merged inside a window it evaluates (the SSOT
 * `mergedPrs` population, inclusive bounds), so an all-time read fetched every
 * other merged PR, parsed every link on its branch, and then discarded it. That
 * all-time population is what made the Sessions usage read the slowest route in
 * the API. Pass the SPAN of every window the caller evaluates; `null` reads
 * every merged PR.
 *
 * @param limiter The caller's request-wide fan-out budget, when it has one. Call
 *   bounds compose by ADDITION, so a caller that also fans out elsewhere in the
 *   same stage must hand its limiter down rather than let this read mint a
 *   second `DB_FANOUT_MAX_CONCURRENCY` beside it.
 */
export function findMergedPrsLinkedToSessions<
  Select extends Prisma.PullRequestDetailSelect,
>(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  select: Select,
  mergedWithin: DeliveryWindow | null = null,
  limiter?: LimitFunction
): Promise<
  MergedPrLinkRead<
    Prisma.PullRequestDetailGetPayload<{ select: Select }> &
      LinkedBranchArtifact
  >
> {
  const matchingLink = deliveryPrLinkFromSessions(where);
  const linkedBranchArtifact = {
    targetLinks: { some: matchingLink },
  } satisfies Prisma.ArtifactWhereInput;
  return withDb(async (db) => {
    const details = (await db.pullRequestDetail.findMany({
      where: {
        // The row's own denormalized org column, not just the org the caller's
        // session `where` carries: it keeps the read tenant-scoped in the query
        // itself, and it is the leading column of
        // `@@index([organizationId, prState, mergedAt])` — the index shape this
        // predicate was built for. Scoping only through the joined branch
        // artifact cannot use it (see the index note in schema.prisma).
        organizationId,
        ...MERGED_PR_DETAIL_WHERE,
        ...(mergedWithin ? { mergedAt: mergedAtWithin(mergedWithin) } : {}),
        branchArtifact: { is: linkedBranchArtifact },
      },
      select: {
        ...select,
        branchArtifact: {
          select: {
            id: true,
            _count: { select: { pullRequestDetails: true } },
          },
        },
      },
    })) as (Prisma.PullRequestDetailGetPayload<{ select: Select }> &
      LinkedBranchArtifact)[];
    const branchIds = [
      ...new Set(details.map((detail) => detail.branchArtifact.id)),
    ];
    const links = await readInIdChunks(
      branchIds,
      (chunk) =>
        db.artifactLink.findMany({
          where: {
            ...matchingLink,
            targetId: { in: chunk },
          },
          select: { targetId: true, metadata: true, branchParticipation: true },
        }),
      limiter
    );
    const pullRequestCountByBranchId = new Map(
      details.map((detail) => [
        detail.branchArtifact.id,
        detail.branchArtifact._count.pullRequestDetails,
      ])
    );
    return {
      details,
      admissionByBranchId: buildSessionPrAdmissionIndex(
        links,
        pullRequestCountByBranchId
      ),
    } as MergedPrLinkRead<
      Prisma.PullRequestDetailGetPayload<{ select: Select }> &
        LinkedBranchArtifact
    >;
  });
}

/**
 * A branch this PR was admitted against, WITH the identity that admitted it.
 *
 * ISS-7705: the identity is load-bearing downstream. A reused branch carries the
 * links of every PR that ever ran on it, so "admitted against branch X" alone
 * cannot tell a later reader WHICH of those links belongs to the admitted PR.
 */
export type MergedPrBranchAdmission = {
  branchArtifactId: string;
  admissionKind: MergedPrBranchAdmissionKind;
  /**
   * The `repo#number` identity whose link metadata admitted this PR, or `null`
   * when a unique-Branch fallback admitted it — a branch with exactly one PR,
   * where the links cannot be ambiguous.
   */
  prIdentity: string | null;
};

/**
 * The minimum PR-detail shape needed to decide whether a session-to-PR link admits
 * a PR row. Delivery coverage uses this for all known session-linked targets;
 * merged-PR metrics add lifecycle fields before delegating here.
 */
export type SessionLinkedPrDetail = {
  number: number | null;
  repositoryId?: string | null;
  repositoryFullName: string | null;
  repository: { fullName: string } | null;
} & LinkedBranchArtifact;

/** Whether the precomputed Branch admission index admits this exact PR row. */
export function sessionLinkedBranches(
  detail: SessionLinkedPrDetail,
  admissionByBranchId: ReadonlyMap<string, SessionPrBranchAdmission>
): MergedPrBranchAdmission[] {
  const repositoryFullName =
    detail.repository?.fullName ?? detail.repositoryFullName ?? null;
  const identity =
    repositoryFullName && detail.number != null
      ? sessionPrIdentityKey(repositoryFullName, detail.number)
      : null;
  const admission = admissionByBranchId.get(detail.branchArtifact.id);
  if (!admission) {
    return [];
  }
  if (identity && admission.exactIdentities.has(identity)) {
    return [
      {
        branchArtifactId: detail.branchArtifact.id,
        admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
        prIdentity: identity,
      },
    ];
  }
  if (admission.legacyUniqueFallback && admission.pullRequestCount === 1) {
    return [
      {
        branchArtifactId: detail.branchArtifact.id,
        admissionKind: MergedPrBranchAdmissionKind.LegacyUniqueBranch,
        prIdentity: null,
      },
    ];
  }
  if (
    canAdmitTierTwoUniqueBranch(detail, admission) &&
    admission.tierTwoUniqueBranchFallback
  ) {
    return [
      {
        branchArtifactId: detail.branchArtifact.id,
        admissionKind: MergedPrBranchAdmissionKind.TierTwoUniqueBranch,
        prIdentity: null,
      },
    ];
  }
  // ISS-7905: branch-level evidence, the last arm on purpose. A non-prose
  // session→branch link vouches for the BRANCH and names no PR, so it admits
  // this branch's merged PRs only when nothing on the branch names one —
  // `exactIdentities` empty. That is what keeps the ISS-7705 per-PR admission
  // governing wherever a command-derived identity exists, so the reused-branch
  // narrowing Kerensa accepted on 2026-08-27 (ISS-8265) is untouched: a branch with
  // a session→PR link for #7 still admits #7 and not the unlinked #9. Where no
  // identity exists at all the choice is between this branch-level arm and the
  // confident `null` the card renders today, and the sanctioned population
  // (`orgMergedPullRequestWhere`) already counts these rows.
  if (
    canAdmitTierTwoUniqueBranch(detail, admission) &&
    admission.branchEvidence &&
    admission.exactIdentities.size === 0
  ) {
    return [
      {
        branchArtifactId: detail.branchArtifact.id,
        admissionKind: MergedPrBranchAdmissionKind.TierTwoUniqueBranch,
        prIdentity: null,
      },
    ];
  }
  return [];
}

/** Whether the precomputed Branch admission index admits this exact PR. */
export function mergedPrLinkedBranches(
  detail: NonNullable<MergedPrDetail> & LinkedBranchArtifact,
  admissionByBranchId: ReadonlyMap<string, SessionPrBranchAdmission>
): MergedPrBranchAdmission[] {
  return sessionLinkedBranches(detail, admissionByBranchId);
}

/**
 * Parses each session-link metadata row once into a Branch admission index.
 *
 * ISS-5823: identities come from {@link commandDerivedSessionPrRefsFromMetadata},
 * not the full set. An `exactIdentities` hit is what admits a merged PR into
 * `mergedPrCount` / `medianPrSize` / `mergedLocPerDollar`, so a prose-derived ref
 * riding on a link that also carries a command-derived one would otherwise buy
 * its PR a place in those numbers through the link-level kind's back door.
 *
 * ISS-7905: `branchEvidence` IS ONLY MEANINGFUL WHEN THE CALLER SUPPLIED THE
 * FULL {@link sessionLinkedPopulationArms} SET. This index is built from
 * whatever links its caller read, so a caller that selected on
 * {@link sessionPrLinkFromSessions} — the reconciler's delivery-coverage tick —
 * passes no session→branch link and gets `branchEvidence: false` on every
 * branch, i.e. exactly its pre-ISS-7905 behaviour. That is deliberate: its
 * monitored ratio is defined over session→PR links and widening it here would
 * move a Datadog series rather than fix one. It does mean the tick measures a
 * NARROWER population than the cards; do not read the two as one number.
 */
export function buildSessionPrAdmissionIndex(
  links: readonly {
    targetId: string;
    metadata: unknown;
    branchParticipation?: string | null;
  }[],
  pullRequestCountByBranchId: ReadonlyMap<string, number>
): Map<string, SessionPrBranchAdmission> {
  const byBranchId = new Map<string, SessionPrBranchAdmission>();
  for (const link of links) {
    const admission = byBranchId.get(link.targetId) ?? {
      exactIdentities: new Set<string>(),
      legacyUniqueFallback: false,
      tierTwoUniqueBranchFallback: false,
      pullRequestCount: pullRequestCountByBranchId.get(link.targetId) ?? 0,
      branchEvidence: false,
    };
    for (const ref of commandDerivedSessionPrRefsFromMetadata(link.metadata)) {
      admission.exactIdentities.add(
        sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber)
      );
    }
    // ISS-9924: one `parseSessionPrLinkMetadata` pass per link, shared by both
    // arms below, which used to run it once each — three passes of that schema
    // per link, seconds of CPU per read over an org's delivery link population.
    // `classifySessionPrMetadata` is a separate schema and still runs twice for
    // a legacy session→PR row: for the refs above, and inside
    // `allowsUniqueBranchPrFallback`.
    const parsed = parseSessionPrLinkMetadata(link.metadata);
    admission.legacyUniqueFallback ||= allowsLegacyUniqueBranchPrFallback(
      link.metadata,
      parsed
    );
    const tierTwo = isTierTwoUniqueBranchFallbackLink(link, parsed);
    admission.tierTwoUniqueBranchFallback ||= tierTwo;
    admission.branchEvidence ||= tierTwo;
    byBranchId.set(link.targetId, admission);
  }
  return byBranchId;
}

/**
 * ISS-7705: the merged PRs admitted against ONE branch, as the link side needs
 * to see them — the inverse of {@link buildSessionPrAdmissionIndex}, which reads
 * links to decide which PRs a branch admits.
 */
export type AdmittedBranchPrs = {
  /** `repo#number` identities admitted by an exact link-metadata match. */
  identities: ReadonlySet<string>;
  /**
   * Whether a PR on this branch was admitted with NO identity — the
   * unique-Branch legacy fallback, or the ISS-7905 branch-evidence arm. Both
   * emit `prIdentity: null`, and the link side answers them the same way: a link
   * that declares no command-derived identity of its own is the one that
   * admitted it.
   */
  legacyUniqueFallback: boolean;
  /** Whether the tier-2 command-Branch fallback admitted a PR on this branch. */
  tierTwoUniqueBranchFallback: boolean;
};

/**
 * Does this link's metadata declare one of the PRs `admitted` against its
 * branch?
 *
 * The link-side MIRROR of {@link mergedPrLinkedBranches}, arm for arm: an exact
 * `repo#number` match, or the unique-Branch legacy fallback. Keep the two in
 * lockstep — a predicate that disagrees with its mirror admits a PR from the
 * branch and then denies the very link that admitted it.
 *
 * ISS-7705: without this, a read scoped only to `targetId` pulls EVERY
 * session→PR link on the branch. On a reused branch (same branch, a second PR)
 * that hands the caller sessions belonging to a PR it never admitted.
 *
 * ISS-5823: reads {@link commandDerivedSessionPrRefsFromMetadata}, NOT the full
 * ref set, because that is what {@link buildSessionPrAdmissionIndex} builds
 * `exactIdentities` from and "arm for arm" above is a real invariant rather than
 * a turn of phrase. Taking the full set here would break the mirror in the one
 * direction that is silent: the branch side would refuse to admit a PR on
 * prose-derived evidence while this side went on admitting the link that
 * declared it, so a link the metrics deliberately excluded would keep pulling
 * its session into a cost-bearing read through the weaker signal.
 */
export function linkDeclaresAdmittedPr(
  metadata: unknown,
  admitted: AdmittedBranchPrs | undefined,
  branchParticipation?: string | null
): boolean {
  if (!admitted) {
    return false;
  }
  for (const ref of commandDerivedSessionPrRefsFromMetadata(metadata)) {
    if (
      admitted.identities.has(
        sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber)
      )
    ) {
      return true;
    }
  }
  // ISS-7905: the identity-less arms, mirrored. `mergedPrLinkedBranches` now
  // admits with a null identity through EITHER the legacy unique-Branch shape or
  // a non-prose session→branch link, so answering only the first would leave the
  // LOC/$ coverage probe unable to find the sessions behind lines the numerator
  // just counted — a `complete` verdict over a cohort of zero, which is the
  // false-completeness this pair of mirrors exists to prevent.
  return (
    (admitted.legacyUniqueFallback &&
      allowsLegacyUniqueBranchPrFallback(metadata)) ||
    (admitted.tierTwoUniqueBranchFallback &&
      isTierTwoUniqueBranchFallbackLink({ metadata, branchParticipation })) ||
    (admitted.legacyUniqueFallback && isNonProseSessionBranchLink(metadata))
  );
}

function allowsLegacyUniqueBranchPrFallback(
  metadata: unknown,
  parsed = parseSessionPrLinkMetadata(metadata)
): boolean {
  return (
    parsed?.linkKind === SessionArtifactLinkKind.SessionPr &&
    allowsUniqueBranchPrFallback(metadata)
  );
}

function canAdmitTierTwoUniqueBranch(
  detail: SessionLinkedPrDetail,
  admission: SessionPrBranchAdmission
): boolean {
  return (
    detail.repositoryId === null &&
    detail.number !== null &&
    admission.pullRequestCount === 1
  );
}

function isTierTwoUniqueBranchFallbackLink(
  link: { metadata: unknown; branchParticipation?: string | null },
  metadata = parseSessionPrLinkMetadata(link.metadata)
): boolean {
  if (!metadata) {
    return false;
  }
  const branchParticipation =
    link.branchParticipation ?? metadata.branchParticipation ?? null;
  return (
    hasSessionBranchLinkKind(metadata) &&
    isWritableBranchParticipation(branchParticipation) &&
    !isProseDerivedLinkMethod(metadata.method)
  );
}

function hasSessionBranchLinkKind(
  metadata: NonNullable<ReturnType<typeof parseSessionPrLinkMetadata>>
): boolean {
  return (
    metadata.linkKind === SessionArtifactLinkKind.SessionBranch ||
    metadata.linkKinds?.includes(SessionArtifactLinkKind.SessionBranch) === true
  );
}

function isWritableBranchParticipation(value: string | null): boolean {
  return value === null || value === BranchParticipationKind.Wrote;
}

function isProseDerivedLinkMethod(method: string | undefined): boolean {
  return (
    method === ArtifactRefMethod.PrMentionInProse ||
    method === ArtifactRefMethod.BranchMentionInProse
  );
}

/** The largest instant a JavaScript `Date` can hold (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;

/**
 * The `mergedAt` filter {@link findMergedPrsLinkedToSessions} applies for a
 * window: the {@link MERGED_PR_DETAIL_WHERE} non-null test plus the window's
 * inclusive bounds, the same test the SSOT `mergedPrs` population applies. An
 * open end arrives as `Number.MAX_SAFE_INTEGER`, past the largest `Date`, so it
 * adds no upper bound.
 */
function mergedAtWithin(
  window: DeliveryWindow
): Prisma.PullRequestDetailWhereInput["mergedAt"] {
  return {
    ...MERGED_PR_DETAIL_WHERE.mergedAt,
    gte: new Date(window.start),
    ...(window.end < MAX_DATE_MS ? { lte: new Date(window.end) } : {}),
  };
}
