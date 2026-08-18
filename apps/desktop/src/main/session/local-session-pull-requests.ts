import type { SessionPR } from "@repo/api/src/types/agent-session";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  collectSessionPrEvidence,
  resolveSessionPrAdmissionIdentity,
  type SessionPrEvidence,
  SessionPrRelationType,
  type SyncedSessionPrRef,
  sessionPrIdentityKey,
  toSessionPrEvidenceRecords,
} from "@repo/api/src/types/session-artifact-link";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { isLocalSessionAuthoredPrGateEnabled } from "./local-session-pr-gate.js";

/**
 * The single write-derived branch resolved for a local session (FEA-2531): the
 * session's most-recent branch-write link, surfaced as `session.branch`. Read
 * sessions carry `null`. This is session-wide — the projection layer does not
 * carry a per-repo branch — so callers that gate a *repository-scoped* PR write
 * on it must also check the ref's repo against the resolved-branch repo
 * ({@link resolvedBranchRepositoryFullName}).
 */
export function resolveLocalSessionBranch(
  session: SyncedAgentSession
): string | null {
  return session.branch ?? null;
}

/**
 * The repository the session's resolved branch write belongs to. `session.branch`
 * is derived from the session's branch-write links, and those writes happen in
 * the session's resolved repository (`attribution.repositoryFullName`). A CREATED
 * PR ref in a *different* repository is therefore NOT vouched for by that branch
 * (FEA-4188 / reviewer: a repo-A branch must not un-orphan a repo-B PR write).
 */
function resolvedBranchRepositoryFullName(
  session: SyncedAgentSession
): string | null {
  return session.attribution?.repositoryFullName ?? null;
}

/**
 * ISS-4922 (wongk review): dedup and the admission gate MUST key a PR the same
 * way, so this lane has no identity helper of its own — it calls the shared
 * {@link sessionPrIdentityKey}. The removed local copy trimmed+lowercased the
 * repo, while `sessionPrIdentityKey` runs it through `normalizeRepoFullName`, so
 * `acme/web.git#42` and `acme/web#42` were ONE identity to the gate and TWO
 * rows here — the same PR rendered twice.
 *
 * Repo comparison outside identity (the FEA-4188 branch-repo check below) goes
 * through the same normalization for the same reason.
 */
function normalizedRepository(
  repositoryFullName: string | null | undefined
): string | null {
  const trimmed = repositoryFullName?.trim();
  return trimmed ? normalizeRepoFullName(trimmed) : null;
}

/**
 * True when a CREATED PR ref is an *orphaned authored write* that must be
 * suppressed: a `CREATED` ref is a PR write (the session authored the PR by
 * pushing its head branch), so it MUST carry the branch it belongs to. It is
 * orphaned when the session resolved no branch write at all, OR when the ref's
 * repository differs from the repository the resolved branch belongs to — a
 * branch write in repo A does not vouch for an authored PR in repo B (FEA-4188).
 * `REFERENCED`/`REVIEWED` refs are mentions/reviews, not authored writes, so they
 * are never gated on a branch.
 */
function isOrphanedCreatedPrWrite(
  ref: SyncedSessionPrRef,
  resolvedBranch: string | null,
  branchRepositoryFullName: string | null
): boolean {
  if (ref.relationType !== SessionPrRelationType.Created) {
    return false;
  }
  if (resolvedBranch === null) {
    return true;
  }
  // A resolved branch only vouches for a CREATED ref in the same repository.
  // When we know the branch's repository, a ref for a different repository is
  // still orphaned. When the branch repository is unknown, fall back to the
  // session-wide "has a branch" signal rather than over-suppressing.
  const branchRepository = normalizedRepository(branchRepositoryFullName);
  return (
    branchRepository !== null &&
    normalizedRepository(ref.repositoryFullName) !== branchRepository
  );
}

/**
 * The PRs to render for a local session, merging the legacy trace `prs` with the
 * artifact-link `prRefs`. Dedup uses repository-scoped identity so
 * `repo-a#42` and `repo-b#42` are distinct, with a number-only fallback reserved
 * for repo-less legacy rows. This mirrors the cloud projection, where both PR
 * sources are folded into the rendered `prs`, so the desktop row's PR column
 * reflects the same data the PR-association filter matches on.
 *
 * FEA-4188: an orphaned CREATED PR write (a PR the session authored but for which
 * no branch — or no *matching-repo* branch — resolved) is suppressed from BOTH
 * sources. This is the desktop-local half of the PR⇒Branch read invariant; the
 * cloud read boundary enforces the same rule for sync/enrichment-associated PRs
 * in `apps/api/.../service/projections.ts` (`enforcePrBranchInvariant`, the
 * FEA-4188 recurrence fix — #3801 covered only this local path). Because
 * SQLite-hydrated sessions emit the same created PR in both
 * `prs` (repo-stripped, number-only) and `prRefs`, suppressing only the `prRefs`
 * entry would leave the legacy `prs` duplicate rendering and matching the
 * "Has PR" filter — so the matching legacy entry is dropped too. The suppressed
 * PR numbers are collected repo-agnostically because the legacy `prs` row carries
 * no repository (identity was stripped by the upstream trace merge), and a
 * session's legacy `prs` are already repo-deduped upstream so a bare number maps
 * to at most one legacy row per session.
 *
 * ISS-4922 — AUTHORED GATE (`authoredGateEnabled`, the `localSessionAuthoredPrGate`
 * Labs flag, default OFF). FEA-3584 (Authored) and FEA-3585 (Reviewed) taught the
 * cloud projection that only a PR the session AUTHORED belongs in its PR set, and
 * ISS-4768 extended that to the legacy blob; none of it reached this lane, so a
 * `REFERENCED`/`REVIEWED` `prRef` rendered as a pill and the same session could
 * read "Pull requests: None" on web while showing a pill on Local. (It could
 * also trip an abandoned-to-Completed rescue on Local only; ISS-6588 removed
 * that rescue, so the pill is the whole divergence now.)
 *
 * ONE GATE, BOTH LANES. The rule is NOT reimplemented here: the two lanes map
 * their different shapes (`SourceLinkRecord` on the cloud, `SyncedSessionPrRef`
 * here) onto the SAME normalized evidence records and call the SAME
 * {@link resolveSessionPrAdmissionIdentity} in
 * `@repo/api/src/types/session-artifact-link`, including its per-PR
 * incomplete-evidence carve-out (an identity no evidence adjudicates is KEPT).
 * Narrowing one lane without the other is no longer possible without editing
 * that shared adjudicator.
 *
 * KNOWN EVIDENCE GAP (stage reviewer): the two lanes share the PREDICATE, not
 * the evidence SET. On the cloud, `collectSessionPrEvidence` is additionally fed
 * `collectBranchReachablePrEvidence` — every PR reachable from the session's
 * branch link, folded in as `Adjudicated`. This lane has no branch→PR
 * reachability to offer: a desktop-local session carries `prRefs` and a single
 * session-wide `branch` string, not the branch's PR set. So a PR reachable from
 * the session's branch but named by NO `CREATED`/`REFERENCED`/`REVIEWED` ref is
 * unadjudicated here and kept by the incomplete-evidence rule, where the cloud
 * would reject it. The gate therefore only ever suppresses a SUBSET of what the
 * cloud suppresses — it never suppresses something the cloud keeps — so turning
 * it on moves Local toward web parity without ever under-reporting relative to
 * it. Closing the gap needs the branch's PR identities on the local lane and is
 * deliberately out of scope here; the Labs copy in
 * `apps/desktop/src/shared/feature-flags.ts` is worded to promise the
 * suppression rule, not full web parity.
 *
 * With the gate OFF the pre-ISS-4922 behavior is reproduced exactly, because
 * suppressing an already-rendered pill is a user-perceivable removal.
 */
export function localSessionPullRequests(
  session: SyncedAgentSession,
  authoredGateEnabled: boolean = isLocalSessionAuthoredPrGateEnabled()
): SessionPR[] {
  const prs = session.prs ?? [];
  const prRefs = session.prRefs ?? [];
  if (prRefs.length === 0) {
    // With the gate ON a session with NO refs has no evidence at all, so every
    // legacy entry is unadjudicated and kept — the same compatibility rule the
    // cloud applies. Short-circuiting here keeps that explicit.
    return prs;
  }
  const evidence = authoredGateEnabled
    ? collectSessionPrEvidence(toSessionPrEvidenceRecords(prRefs))
    : null;
  const resolvedBranch = resolveLocalSessionBranch(session);
  const branchRepositoryFullName = resolvedBranchRepositoryFullName(session);

  // Partition refs into kept (repo-scoped, deduped) vs suppressed orphaned
  // writes. Suppressed PR numbers are recorded so the same PR's legacy `prs`
  // duplicate (repo-stripped by the upstream trace merge) is dropped too.
  // First pass over `prRefs`: split into orphaned CREATED writes (suppressed)
  // and kept refs. Suppressed PR numbers are recorded so the same PR's legacy
  // `prs` duplicate (repo-stripped by the upstream trace merge) is dropped too.
  const { keptRefs, suppressedPrNumbers } = partitionPrRefs(
    prRefs,
    resolvedBranch,
    branchRepositoryFullName,
    evidence !== null
  );

  // Legacy `prs` win over a same-number ref (mirrors the original fold), but a
  // suppressed orphaned write's repo-stripped legacy twin is dropped so the
  // suppression truly removes the PR from the rendered column and the "Has PR"
  // filter — not just its `prRefs` half (FEA-4188 / Codex reviewer).
  const seenIdentities = new Set<string>();
  const legacyNumbers = new Set<string>();
  const merged: SessionPR[] = [];
  for (const pr of prs) {
    const normalizedNumber = String(pr.num).trim();
    if (
      suppressedPrNumbers.has(normalizedNumber) ||
      // ISS-4922: the legacy blob half. The desktop legacy `prs` row carries no
      // repository (identity was stripped by the upstream trace merge), so it is
      // adjudicated at the repo-less identity — exactly the case the shared
      // gate's ADMISSION/ADJUDICATION asymmetry is written for.
      (evidence !== null && !isAdmittedLegacyPr(pr.num, session, evidence))
    ) {
      continue;
    }
    legacyNumbers.add(normalizedNumber);
    // Legacy rows carry no repository, so they key on the number-only legacy
    // identity; a same-number ref below dedupes against it.
    seenIdentities.add(sessionPrIdentityKey(null, normalizedNumber));
    merged.push(pr);
  }
  for (const ref of keptRefs) {
    const normalizedNumber = String(ref.prNumber).trim();
    // A repo-less legacy row of the same number already represents this PR (the
    // trace + artifact-link are two views of one PR) — don't render a second row.
    if (legacyNumbers.has(normalizedNumber)) {
      continue;
    }
    // Repo-scoped dedup so repo-a#42 and repo-b#42 stay distinct rows and a
    // duplicate artifact-link for one repo folds once (FEA-4188 / wongk reviewer;
    // `apps/desktop/AGENTS.md` "Agent Monitor Inputs").
    const identity = sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber);
    if (seenIdentities.has(identity)) {
      continue;
    }
    seenIdentities.add(identity);
    merged.push({
      num: ref.prNumber,
      title: `${ref.repositoryFullName}#${ref.prNumber}`,
      // relationType (created/referenced/reviewed) is not a lifecycle status, so
      // these artifact-link PRs are correctly excluded from the merged-PR count.
      status: ref.relationType,
    });
  }
  return merged;
}

/**
 * True when a local session carries a PR. Derived from the same merged
 * projection the Sessions row renders ({@link localSessionPullRequests}), so the
 * "Has PR" / "No PR" filter can never disagree with the row's PR column.
 */
export function localSessionHasPr(
  session: SyncedAgentSession,
  authoredGateEnabled: boolean = isLocalSessionAuthoredPrGateEnabled()
): boolean {
  return localSessionPullRequests(session, authoredGateEnabled).length > 0;
}

/**
 * ISS-4922: run one legacy `prs` entry through the SHARED admission gate. The
 * legacy row carries no repository of its own, so the session's resolved
 * repository is offered as its repo — mirroring the cloud, which adjudicates the
 * blob against `record.repositoryFullName`. A `null` verdict is the phantom: an
 * identity the session's own refs adjudicated and did not call authoring.
 */
function isAdmittedLegacyPr(
  prNumber: number | string,
  session: SyncedAgentSession,
  evidence: SessionPrEvidence
): boolean {
  return (
    resolveSessionPrAdmissionIdentity(
      {
        prNumber,
        repositoryFullName: session.attribution?.repositoryFullName ?? null,
      },
      evidence
    ) !== null
  );
}

/**
 * Split `prRefs` into the refs that may render and the PR numbers whose legacy
 * `prs` twin must be dropped with them.
 *
 * Two independent suppressions live here. FEA-4188: an ORPHANED `CREATED` write
 * (a PR the session authored with no — or no matching-repo — resolved branch) is
 * dropped from BOTH sources, so its repo-stripped legacy twin is recorded by
 * number. ISS-4922: with the gate on, a non-authoring ref mints no pill at all,
 * the direct analogue of the cloud's `applyAuthoredPrLink` returning null for a
 * non-Authored purpose. Its legacy twin is deliberately NOT suppressed by number
 * here — the shared adjudicator decides that off the FULL evidence set, so a
 * same-number PR the session really did author in another repository is not
 * collaterally dropped.
 */
function partitionPrRefs(
  prRefs: readonly SyncedSessionPrRef[],
  resolvedBranch: string | null,
  branchRepositoryFullName: string | null,
  authoredGateEnabled: boolean
): { keptRefs: SyncedSessionPrRef[]; suppressedPrNumbers: Set<string> } {
  const suppressedPrNumbers = new Set<string>();
  const keptRefs: SyncedSessionPrRef[] = [];
  for (const ref of prRefs) {
    if (
      isOrphanedCreatedPrWrite(ref, resolvedBranch, branchRepositoryFullName)
    ) {
      suppressedPrNumbers.add(String(ref.prNumber).trim());
      continue;
    }
    if (
      authoredGateEnabled &&
      ref.relationType !== SessionPrRelationType.Created
    ) {
      continue;
    }
    keptRefs.push(ref);
  }
  return { keptRefs, suppressedPrNumbers };
}
