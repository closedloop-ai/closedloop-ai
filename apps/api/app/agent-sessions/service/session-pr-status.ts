// Session→PR status projection: resolve each linked PR to its own verified
// lifecycle (current pointer OR historical detail), preserving a verified
// merged/closed/open outcome rather than erasing it to Unknown (FEA-4251 /
// FEA-4317). Split out of projections.ts to keep that file under the size
// ceiling; the shared identity/link primitives are re-exported for the branch
// and KLOC lanes that still live in projections.ts.

import type { SessionPR } from "@repo/api/src/types/agent-session";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { PullRequestState } from "@repo/api/src/types/document";
import {
  collectSessionPrEvidence,
  deriveSessionPrPurposeFromMetadata,
  parseSessionPrLinkMetadata,
  resolveSessionPrAdmissionIdentity,
  type SessionPrEvidence,
  SessionPrEvidenceKind,
  type SessionPrEvidenceRecord,
  SessionPrPurpose,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import {
  SessionPrLifecycleStatus,
  sessionPrWithLifecycle,
} from "@repo/lib/session-trace/derivation";
import { sessionPrSchema } from "@/lib/desktop-agent-sessions-schema";
import { parseJsonArray } from "./coercion";
import type { AgentSessionListRecord } from "./records";

export type SourceLinkRecord = NonNullable<
  AgentSessionListRecord["artifact"]["sourceLinks"]
>[number];

/**
 * The canonical repo-scoped PR identity `<repo>#<n>`, or the repo-unknown
 * `legacy#<n>` twin when the source carries no repository.
 *
 * ISS-4922: the implementation now lives in
 * `@repo/api/src/types/session-artifact-link` so the desktop Local lane keys on
 * the exact same identity as this one; this re-export keeps the cloud-side name
 * (and its importers in `projections.ts`) working unchanged.
 */
export const sessionPullRequestIdentityKey = sessionPrIdentityKey;

function resolveTrustedPrDetail(
  link: SourceLinkRecord,
  repositoryFullName: string,
  prNumber: number
):
  | NonNullable<
      SourceLinkRecord["target"]["branch"]
    >["currentPullRequestDetail"]
  | null {
  const detail = link.target?.branch?.currentPullRequestDetail ?? null;
  if (!detail?.isCurrent || detail.lastVerifiedAt == null) {
    return null;
  }
  const branchRepoRaw =
    link.target?.branch?.repository?.fullName ?? repositoryFullName;
  // FEA-2732: repo-less (non-App) PRs have a null `repository` relation; verify
  // their repo identity via the producer-independent `repositoryFullName`.
  // Normalize both sides: the stored `repositoryFullName` is lowercased while
  // the installation-repo relation / raw meta carry GitHub's canonical casing,
  // so a raw compare would reject valid mixed-case repos (e.g. microsoft/TypeScript).
  const detailRepoRaw =
    detail.repository?.fullName ?? detail.repositoryFullName;
  if (
    !detailRepoRaw ||
    normalizeRepoFullName(detailRepoRaw) !==
      normalizeRepoFullName(branchRepoRaw) ||
    detail.number !== prNumber
  ) {
    return null;
  }
  return detail;
}

/**
 * Resolves a session→PR source link to the `(repositoryFullName, prNumber)` it
 * should be attributed under — but ONLY when the session actually AUTHORED the
 * PR (FEA-3584). A link the session merely *references* (e.g. a standup that
 * names PR numbers in prose to compose a message) derives to the `Referenced`/
 * `Unknown` purpose and returns null, so it stays visible in the transcript /
 * timeline but is dropped from the PR-output projection and can't inflate a
 * session's PR count or merged count. A `REVIEWED` link (FEA-3585 — a
 * `gh pr view/diff/review <n>` on a specific PR) likewise derives to the
 * `Reviewed` purpose, which is NOT `Authored`, so it too is excluded from PR
 * output (a reviewer authored no PR). Authoring evidence is the desktop
 * extractor's `CREATED` relationType (git_push / gh_pr_create), which derives to
 * the `Authored` purpose. Returns null for malformed metadata missing the repo
 * or PR number.
 */
export function resolveAuthoredPrLinkIdentity(
  link: SourceLinkRecord
): { repositoryFullName: string; prNumber: number } | null {
  const meta = link.metadata as Record<string, unknown> | null;
  const repositoryFullName = meta?.repositoryFullName as string | undefined;
  const prNumber = meta?.prNumber as number | undefined;
  if (!repositoryFullName || prNumber == null) {
    return null;
  }
  const purpose = deriveSessionPrPurposeFromMetadata(
    parseSessionPrLinkMetadata(link.metadata)
  );
  if (purpose !== SessionPrPurpose.Authored) {
    return null;
  }
  return { repositoryFullName, prNumber };
}

/**
 * Mutable accumulator for the session→PR projection: the identity-keyed PR set
 * plus the identities whose Merged status came from VERIFIED detail (so the
 * merged count never trusts a desktop-reported "merged"). Extracted so the two
 * enrichment passes stay small and share one dedup/settle path (FEA-4251).
 */
type SessionPrAccumulator = {
  byIdentity: Map<string, SessionPR>;
  verifiedMergedIdentities: Set<string>;
};

/**
 * Settle one resolved PR into the accumulator at its repo-scoped identity,
 * collapsing the repo-unknown `legacy#<n>` twin onto it (FEA-3297: a link that
 * supplies a repositoryFullName governs identity, so the PR is never listed
 * twice). `verifiedMerged` records whether a VERIFIED detail backed the Merged
 * status, gating the merged count.
 */
function settleResolvedPr(
  acc: SessionPrAccumulator,
  identityKey: string,
  legacyIdentityKey: string,
  pr: SessionPR,
  verifiedMerged: boolean
): void {
  acc.byIdentity.delete(legacyIdentityKey);
  acc.verifiedMergedIdentities.delete(legacyIdentityKey);
  acc.byIdentity.set(identityKey, pr);
  if (verifiedMerged && pr.status === SessionPrLifecycleStatus.Merged) {
    acc.verifiedMergedIdentities.add(identityKey);
  } else {
    acc.verifiedMergedIdentities.delete(identityKey);
  }
}

/** First pass: enrich/attribute PRs the session AUTHORED (FEA-3584). */
function applyAuthoredPrLink(
  acc: SessionPrAccumulator,
  link: SourceLinkRecord
): void {
  const attributed = resolveAuthoredPrLinkIdentity(link);
  if (!attributed) {
    return;
  }
  const { repositoryFullName, prNumber } = attributed;
  const trustedDetail = resolveTrustedPrDetail(
    link,
    repositoryFullName,
    prNumber
  );
  const identityKey = sessionPullRequestIdentityKey(
    repositoryFullName,
    prNumber
  );
  const legacyIdentityKey = sessionPullRequestIdentityKey(null, prNumber);
  const existingPr =
    acc.byIdentity.get(identityKey) ?? acc.byIdentity.get(legacyIdentityKey);
  const pr = sessionPrWithLifecycle({
    num: prNumber,
    title: trustedDetail?.title ?? existingPr?.title ?? null,
    status: trustedDetail
      ? null
      : sanitizeUnverifiedSessionPrStatus(existingPr?.status),
    prState: trustedDetail?.prState ?? null,
    closedAt: trustedDetail?.closedAt ?? null,
    mergedAt: trustedDetail?.mergedAt ?? null,
  });
  settleResolvedPr(
    acc,
    identityKey,
    legacyIdentityKey,
    pr,
    Boolean(trustedDetail)
  );
}

/**
 * A verified PR detail — from EITHER a branch's current pointer or its historical
 * set — resolved to its own `(repositoryFullName, prNumber)` identity. Both
 * lifecycle sources carry the same lifecycle columns (FEA-4317 widened the
 * historical `pullRequestDetails` select to mirror `currentPullRequestDetail`),
 * so a single shape covers both.
 */
type VerifiedPrDetail = {
  repositoryFullName: string;
  prNumber: number;
  title: string | null;
  prState: string | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  // FEA-4317 (codex P2): true only when this detail IS the PR its source link
  // actually declares (`link.metadata.repositoryFullName + prNumber`), not an
  // incidental same-number sibling in the branch's historical set. Only a
  // link-declared detail may claim the repo-less `legacy#<n>` twin; a sibling
  // resolves at its OWN `<repo>#<n>` identity and must never delete a `legacy#<n>`
  // that belongs to a different repo's PR (see {@link applyVerifiedPrDetails}).
  matchesLinkDeclaredPr: boolean;
};

/** The `(repositoryFullName, prNumber)` a source link authoritatively declares. */
function sessionPrLinkDeclaredIdentity(
  link: SourceLinkRecord
): { repositoryFullName: string; prNumber: number } | null {
  const meta = link.metadata as Record<string, unknown> | null;
  const repositoryFullName = meta?.repositoryFullName;
  const prNumber = meta?.prNumber;
  if (typeof repositoryFullName !== "string" || typeof prNumber !== "number") {
    return null;
  }
  return { repositoryFullName, prNumber };
}

/**
 * FEA-4317 (wongk review): a PR detail's lifecycle is only VERIFIED when a
 * producer actually observed it. `lastVerifiedAt` alone is insufficient: a
 * desktop bare-ref row (a `git_push`/`gh_pr_create` extraction that named a PR
 * number but never ran `gh pr view`) is inserted with the Prisma
 * `prState @default(OPEN)` and no lifecycle timestamps, yet still gets a
 * `lastVerifiedAt` stamp — so trusting `lastVerifiedAt` would launder an Unknown
 * session PR into a fabricated Open the producer never observed. A genuine
 * lifecycle observation carries a terminal timestamp (`mergedAt`/`closedAt`),
 * a terminal `prState` (Merged/Closed), or the PR-opened timestamp
 * `githubCreatedAt` (written only by the webhook / `gh` fetch / App backfill
 * paths that truly saw the PR). Absent all of those, the Open is a default, not
 * an observation, and the PR stays Unknown.
 */
function hasObservedPrLifecycle(detail: {
  prState?: string | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  githubCreatedAt?: Date | null;
}): boolean {
  return (
    detail.mergedAt != null ||
    detail.closedAt != null ||
    detail.prState === PullRequestState.Merged ||
    detail.prState === PullRequestState.Closed ||
    detail.githubCreatedAt != null
  );
}

/**
 * FEA-4317: one link's FULL set of freshness-verified PR details — the branch's
 * `currentPullRequestDetail` pointer AND its historical `pullRequestDetails[]`
 * (the Artifact-level `BranchPullRequests` relation). A session may link a PR
 * that is no longer the branch's current detail (a newer PR was raised from the
 * same reused branch); its verified merged/open/closed state lives ONLY in the
 * historical set, so consulting the current pointer alone (as the FEA-4251 pass
 * did) erases it and re-reports it as "unknown". Each candidate keeps the same
 * freshness gate as {@link resolveTrustedPrDetail} (`lastVerifiedAt != null`)
 * PLUS the lifecycle-observed gate {@link hasObservedPrLifecycle} so an
 * unverified/stale/default-only detail can never launder an unknown PR into a
 * claimed state. `isCurrent` is deliberately NOT required — a historical
 * (superseded) PR is `isCurrent: false` yet its verified lifecycle is still real.
 */
function collectVerifiedPrDetailsFromLink(
  link: SourceLinkRecord
): VerifiedPrDetail[] {
  const branch = link.target?.branch;
  if (!branch) {
    return [];
  }
  const candidates = [
    branch.currentPullRequestDetail,
    ...(link.target?.pullRequestDetails ?? []),
  ];
  const branchRepoRaw = branch.repository?.fullName ?? null;
  const declared = sessionPrLinkDeclaredIdentity(link);
  const resolved: VerifiedPrDetail[] = [];
  for (const detail of candidates) {
    if (
      !detail ||
      detail.lastVerifiedAt == null ||
      detail.number == null ||
      // FEA-4317 (wongk review): reject a `lastVerifiedAt`-stamped row whose
      // lifecycle was never observed (a default-OPEN desktop bare-ref).
      !hasObservedPrLifecycle(detail)
    ) {
      continue;
    }
    const repositoryFullName =
      detail.repository?.fullName ?? detail.repositoryFullName ?? branchRepoRaw;
    if (!repositoryFullName) {
      continue;
    }
    resolved.push({
      repositoryFullName,
      prNumber: detail.number,
      title: detail.title ?? null,
      prState: detail.prState ?? null,
      closedAt: detail.closedAt ?? null,
      mergedAt: detail.mergedAt ?? null,
      // FEA-4317 (codex P2): the detail IS the link's declared PR only when its
      // repo + number match the link's own metadata identity. A same-number
      // historical sibling on the branch is NOT link-declared.
      matchesLinkDeclaredPr:
        declared != null &&
        declared.prNumber === detail.number &&
        normalizeRepoFullName(declared.repositoryFullName) ===
          normalizeRepoFullName(repositoryFullName),
    });
  }
  return resolved;
}

/**
 * Purpose-agnostic pass (FEA-4251, extended by FEA-4317): resolve PRs ALREADY in
 * the set (from the desktop-reported legacy JSON, or an authored link) that still
 * carry the status-less "unknown" placeholder, using any VERIFIED PR detail the
 * platform has on ANY of the session's PR links — referenced/reviewed included,
 * and now HISTORICAL details (a superseded PR whose merged status lives only in
 * the branch's `pullRequestDetails[]`, not its `currentPullRequestDetail`).
 * Enriches existing entries only, so a PR the session merely referenced is never
 * ADDED here, and a genuinely-unresolvable PR keeps its honest "unknown".
 *
 * A verified detail is deduped by its own repo-scoped identity, so the same PR
 * reachable via both the current pointer and the historical set (or via multiple
 * links) is settled exactly once. The historical set can hold several distinct
 * PRs (#1 merged, #2 open); each resolves against the accumulator entry that
 * shares its number+repo, so a session linked to the merged #1 keeps #1's merged
 * state even while the branch's current pointer is the open #2.
 */
function applyVerifiedPrDetails(
  acc: SessionPrAccumulator,
  details: readonly VerifiedPrDetail[]
): void {
  const seen = new Set<string>();
  for (const detail of details) {
    const identityKey = sessionPullRequestIdentityKey(
      detail.repositoryFullName,
      detail.prNumber
    );
    // A PR reachable via both the current pointer and the historical set (or via
    // multiple links) is settled once; the first verified detail wins.
    if (seen.has(identityKey)) {
      continue;
    }
    // FEA-4317 (codex P2): a repo-unknown session stores each legacy PR under
    // the shared `legacy#<n>` key (repo dropped). Only a detail that IS the
    // link's declared PR may claim that bare twin; a same-number historical
    // sibling from another repo's branch must not consume (and then delete via
    // `settleResolvedPr`) a `legacy#<n>` that belongs to a different repo's PR.
    const legacyIdentityKey = detail.matchesLinkDeclaredPr
      ? sessionPullRequestIdentityKey(null, detail.prNumber)
      : identityKey;
    const existingPr =
      acc.byIdentity.get(identityKey) ?? acc.byIdentity.get(legacyIdentityKey);
    if (!existingPr) {
      continue;
    }
    seen.add(identityKey);
    const pr = sessionPrWithLifecycle({
      num: detail.prNumber,
      title: detail.title ?? existingPr.title ?? null,
      status: null,
      prState: detail.prState,
      closedAt: detail.closedAt,
      mergedAt: detail.mergedAt,
    });
    settleResolvedPr(acc, identityKey, legacyIdentityKey, pr, true);
  }
}

/**
 * ISS-4768: what a session's own source links say about each PR identity — the
 * identities the links ADJUDICATE at all, and the subset the session actually
 * AUTHORED. This is the evidence set the desktop-reported legacy `pullRequests`
 * blob is admitted against (see {@link resolveLegacyBlobAdmissionIdentity}).
 *
 * `adjudicatedIdentities` is deliberately PER-PR, not a per-session switch (bot
 * + codex review): a session having *one* PR link does not prove the extractor
 * saw *all* of its PR relationships, and the desktop producer independently caps
 * both the blob and `prRefs` at 100 through different orderings — so a real
 * authored PR can arrive in the blob with its link capped out. An identity is
 * adjudicated when a link actually speaks about that PR:
 *   - a session→PR link declares it (any purpose — Referenced/Reviewed/Created),
 *     which is the ISS-4768 phantom shape when the purpose is not Authoring; or
 *   - it is reachable from a session→BRANCH link's PR details, which is the
 *     FEA-2531 branch-inheritance shape (the session merely checked the branch
 *     out via CWD and the branch carries its own PR).
 * A PR NO link speaks about at all is unadjudicated: the evidence is incomplete,
 * not exculpatory, so it is kept (see the compatibility note on the resolver).
 *
 * All identity sets are repo-scoped (`<repo>#<n>`), the canonical PR identity,
 * with the repo-less `legacy#<n>` twin stored alongside for records that carry no
 * `repositoryFullName`. Because the two key spaces are namespaced they share one
 * set without colliding. `authoredLegacyIdentities` holds the repo-less
 * `legacy#<n>` twin of each authored identity, consulted ONLY for a record that
 * carries no `repositoryFullName` (see the asymmetry note on the resolver below).
 * Every key is built through {@link sessionPullRequestIdentityKey} so a blob
 * `num` that arrived as a string normalizes identically to a link's numeric
 * `prNumber`, and `acme/web.git` normalizes onto `acme/web`.
 */
type SessionPrLinkEvidence = SessionPrEvidence;

/**
 * Every PR identity reachable from a link's BRANCH target — its current pointer
 * and its historical `pullRequestDetails[]`. Unlike
 * {@link collectVerifiedPrDetailsFromLink} this deliberately applies NO freshness
 * or lifecycle-observed gate: the question here is not "may this detail supply a
 * lifecycle" but "did this session's branch relationship put this PR within
 * inheritance reach", and an unverified detail reaches just as far.
 */
function collectBranchReachablePrEvidence(
  link: SourceLinkRecord
): SessionPrEvidenceRecord[] {
  const branch = link.target?.branch;
  if (!branch) {
    return [];
  }
  const branchRepoRaw = branch.repository?.fullName ?? null;
  const records: SessionPrEvidenceRecord[] = [];
  const candidates = [
    branch.currentPullRequestDetail,
    ...(link.target?.pullRequestDetails ?? []),
  ];
  for (const detail of candidates) {
    if (!detail || detail.number == null) {
      continue;
    }
    records.push({
      kind: SessionPrEvidenceKind.Adjudicated,
      prNumber: detail.number,
      repositoryFullName:
        detail.repository?.fullName ??
        detail.repositoryFullName ??
        branchRepoRaw,
    });
  }
  return records;
}

/**
 * ISS-4922: map this lane's `SourceLinkRecord` shape onto the NORMALIZED
 * evidence records the shared gate consumes, then let
 * {@link collectSessionPrEvidence} fold them. The desktop Local lane maps its
 * own `SyncedSessionPrRef` shape onto the same records, so both lanes reach the
 * one adjudicator instead of re-deriving the rule.
 */
function collectSessionPrLinkEvidence(
  links: readonly SourceLinkRecord[]
): SessionPrLinkEvidence {
  const records: SessionPrEvidenceRecord[] = [];
  for (const link of links) {
    const declared = sessionPrLinkDeclaredIdentity(link);
    if (declared) {
      records.push({
        kind: SessionPrEvidenceKind.Adjudicated,
        prNumber: declared.prNumber,
        repositoryFullName: declared.repositoryFullName,
      });
    }
    records.push(...collectBranchReachablePrEvidence(link));
    const authored = resolveAuthoredPrLinkIdentity(link);
    if (authored) {
      records.push({
        kind: SessionPrEvidenceKind.Authored,
        prNumber: authored.prNumber,
        repositoryFullName: authored.repositoryFullName,
      });
    }
  }
  return collectSessionPrEvidence(records);
}

/**
 * ISS-4768: the Authored gate, extended to the desktop-reported legacy
 * `pullRequests` JSON blob — previously the ONE ungated way a PR could enter a
 * session's rendered set.
 *
 * The blob is produced by the desktop sync query, which admits a PR linked by
 * `relation IN ('created','workspace')` OR `method = 'harness_pr_link'`. So a PR
 * the session merely REFERENCED — a harness-reported pr-link record, or a
 * branch↔PR association the session only touched via its CWD checkout — lands in
 * the blob and, seeded ungated, rendered verbatim as that session's PR. That is
 * the phantom: a session whose transcript names no PR showing one anyway, while
 * a link-derived PR of the exact same (Referenced) purpose is correctly dropped
 * by {@link resolveAuthoredPrLinkIdentity}. One rule, every injection path.
 *
 * SCOPE — CLOUD READ BOUNDARY ONLY, DELIBERATELY (logical-QA cross-surface
 * review). The desktop **Local** lane builds its own PR set in
 * `apps/desktop/src/main/session/local-session-pull-requests.ts` from
 * `SyncedAgentSession.prs` + `prRefs`, and carries NO authoring gate: it renders
 * a `REFERENCED`/`REVIEWED` `prRef` as a pill, so the same session can read
 * "Pull requests: None" here and show a pill on Local. That divergence is mostly
 * PRE-EXISTING — the link-derived half has been there since FEA-3584/FEA-3585
 * gated this lane and not that one — and ISS-4768 widens it to the blob half.
 * Closing it is not a comment away: the two lanes consume different shapes
 * (`SourceLinkRecord` vs `SyncedSessionPrRef`), a shared predicate has to live in
 * `packages/api/src/types/session-artifact-link.ts` over a normalized evidence
 * shape, and suppressing Local pills is a user-perceivable desktop change that
 * needs its own Labs gate. (It also needed a look at the FEA-3551 rescue that
 * read `prsCount`/`prsMerged` off that same ungated set — ISS-6588 removed the
 * rescue, so the PR set no longer feeds any session outcome.) Tracked as
 * ISS-4922; do not silently narrow one lane without the other.
 *
 * COMPATIBILITY / INCOMPLETE EVIDENCE (do not narrow without approval): the gate
 * is PER PR, never a per-session switch. It rejects only an identity the session's
 * own links ADJUDICATED and did not call authoring. A blob PR no link speaks about
 * is unadjudicated — which happens for a stored row predating session→PR link
 * extraction, for a version-skewed partial row, and for a real authored PR whose
 * link was capped out by the desktop producer's independent 100-row caps on the
 * blob and on `prRefs` (`apps/desktop/src/main/database/sync-source.ts`) — so it is
 * KEPT. Absent evidence is incomplete, not exculpatory; suppression requires a
 * link that actually looked at this PR and classified it as something other than
 * authoring. Graceful degradation, never silent deletion.
 *
 * Returns the identity the entry should be SEEDED at, or null to reject:
 *   1. authored at the record's own repo → that repo-scoped identity.
 *   2. the record carries NO repo and the number is authored by some link → the
 *      repo-less `legacy#<n>` twin, the documented legacy number-only fallback.
 *   3. adjudicated but not authored → null. The ISS-4768 phantom.
 *   4. unadjudicated → the record's identity (the compatibility keep above).
 *
 * ADMISSION is repo-scoped while ADJUDICATION also consults `legacy#<n>`, and the
 * asymmetry is deliberate. The blob carries only `num`; its repo is inherited from
 * the record, so a blob `#42` on a record in repo A is indistinguishable from
 * `A#42` and from a repo-less `#42`. Consulting `legacy#<n>` to REJECT is
 * conservative — some link looked at a `#42` relationship and did not call it
 * authoring. Consulting it to ADMIT would fold repo A's blob title onto repo B's
 * authored `#42`, i.e. fabricate an attribution from an ambiguous match; the
 * cross-repo tests pin that the PR then surfaces from its link at its own identity
 * with the honest `PR #<n>` default rather than the other repository's title.
 */
function resolveLegacyBlobAdmissionIdentity(
  pr: SessionPR,
  repositoryFullName: string | null | undefined,
  evidence: SessionPrLinkEvidence
): string | null {
  return resolveSessionPrAdmissionIdentity(
    { prNumber: pr.num, repositoryFullName },
    evidence
  );
}

export function toSessionPullRequestProjection(
  record: AgentSessionListRecord
): {
  prs: SessionPR[];
  verifiedMergedCount: number;
} {
  const legacyPrs = parseJsonArray<SessionPR>(
    record.pullRequests,
    sessionPrSchema
  );
  const acc: SessionPrAccumulator = {
    byIdentity: new Map<string, SessionPR>(),
    verifiedMergedIdentities: new Set<string>(),
  };
  const links = record.artifact.sourceLinks ?? [];
  // ISS-4768: adjudicate the legacy blob against the session's own link evidence
  // BEFORE seeding, so an uncorroborated (referenced-only / CWD-branch-inherited)
  // blob entry never enters the set. Because the later verified-detail pass only
  // ENRICHES entries already present, closing this seam also closes the
  // branch→`currentPullRequestDetail` inheritance path: a branch's PR can no
  // longer be introduced by a session that merely checked that branch out.
  const linkEvidence = collectSessionPrLinkEvidence(links);
  for (const pr of legacyPrs) {
    const admittedIdentity = resolveLegacyBlobAdmissionIdentity(
      pr,
      record.repositoryFullName,
      linkEvidence
    );
    if (admittedIdentity === null) {
      continue;
    }
    acc.byIdentity.set(admittedIdentity, toUnverifiedSessionPullRequest(pr));
  }
  for (const link of links) {
    applyAuthoredPrLink(acc, link);
  }
  // FEA-4251/FEA-4317: resolve every remaining "unknown" entry against the FULL
  // set of verified PR details across ALL links — each link's current pointer AND
  // its historical `pullRequestDetails[]` — so a session linked to a historical
  // merged PR keeps that verified merged state even when the branch's current
  // detail has moved on to a newer PR.
  const verifiedDetails = links.flatMap(collectVerifiedPrDetailsFromLink);
  applyVerifiedPrDetails(acc, verifiedDetails);
  return {
    prs: [...acc.byIdentity.values()],
    verifiedMergedCount: [...acc.verifiedMergedIdentities].filter((identity) =>
      acc.byIdentity.has(identity)
    ).length,
  };
}

function toUnverifiedSessionPullRequest(pr: SessionPR): SessionPR {
  return {
    ...pr,
    status: sanitizeUnverifiedSessionPrStatus(pr.status),
  };
}

function sanitizeUnverifiedSessionPrStatus(
  status: string | null | undefined
): SessionPR["status"] {
  if (status?.trim().toLowerCase() === SessionPrLifecycleStatus.Merged) {
    return SessionPrLifecycleStatus.Unknown;
  }
  return sessionPrWithLifecycle({
    num: 0,
    title: null,
    status: status ?? null,
    prState: null,
    closedAt: null,
    mergedAt: null,
  }).status;
}
