import { z } from "zod";
import type { ReviewDecision } from "./branch-checks.js";
import {
  normalizeRepoFullName,
  parseRepositoryFullName,
} from "./branch-repository.ts";
import { GitHubPRState } from "./github-status.js";

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

const selectedPullRequestRepositoryFullNameSchema = z
  .string()
  .transform(normalizeRepoFullName)
  .pipe(z.string().regex(REPOSITORY_FULL_NAME_PATTERN));
const selectedPullRequestNumberSchema = z.coerce.number().int().positive();

/**
 * Optional repository-qualified PR selection used by Branch detail/comments.
 * Omission preserves legacy default selection; a caller may never send half an
 * identity and absent values remain omitted on the wire.
 */
export const branchSelectedPullRequestQuerySchema = z
  .object(branchSelectedPullRequestQueryShape())
  .strict()
  .superRefine(requireWholeSelectedPullRequestIdentity);
export type BranchSelectedPullRequestQuery = z.infer<
  typeof branchSelectedPullRequestQuerySchema
>;

/** Canonical repository-qualified identity after boundary validation. */
export type BranchSelectedPullRequestIdentity = {
  repositoryFullName: string;
  pullRequestNumber: number;
};

/** The persisted surface that supplied an associated pull-request collection. */
export const BranchAssociatedPullRequestProvenance = {
  PersistedCloud: "persisted_cloud",
  PersistedDesktop: "persisted_desktop",
} as const;
export type BranchAssociatedPullRequestProvenance =
  (typeof BranchAssociatedPullRequestProvenance)[keyof typeof BranchAssociatedPullRequestProvenance];

/** Truthfulness state for the all-known associated pull-request collection. */
export const BranchAssociatedPullRequestCompletenessState = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchAssociatedPullRequestCompletenessState =
  (typeof BranchAssociatedPullRequestCompletenessState)[keyof typeof BranchAssociatedPullRequestCompletenessState];

/** Closed reasons explaining why persisted associated-PR evidence is not complete. */
export const BranchAssociatedPullRequestCompletenessReason = {
  ConflictingDuplicate: "conflicting_duplicate",
  InvalidIdentity: "invalid_identity",
  InvalidLifecycle: "invalid_lifecycle",
  InvalidTimestamp: "invalid_timestamp",
  MissingTerminalTimestamp: "missing_terminal_timestamp",
  MultipleActive: "multiple_active",
} as const;
export type BranchAssociatedPullRequestCompletenessReason =
  (typeof BranchAssociatedPullRequestCompletenessReason)[keyof typeof BranchAssociatedPullRequestCompletenessReason];

/** Why the contract did or did not choose a default pull request. */
export const BranchAssociatedPullRequestSelectionReason = {
  Active: "active",
  Ambiguous: "ambiguous",
  Explicit: "explicit",
  MostRecentTerminal: "most_recent_terminal",
  None: "none",
  /** ISS-8422: the only candidate is one no producer ever observed. */
  Unobserved: "unobserved",
} as const;
export type BranchAssociatedPullRequestSelectionReason =
  (typeof BranchAssociatedPullRequestSelectionReason)[keyof typeof BranchAssociatedPullRequestSelectionReason];

/** One canonical repository-qualified pull request associated with a Branch. */
export type BranchAssociatedPullRequest = {
  id: string;
  repositoryFullName: string;
  number: number;
  title: string | null;
  url: string | null;
  state: GitHubPRState;
  isDraft: boolean | null;
  reviewDecision: ReviewDecision | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  /**
   * ISS-8422: `false` when this row's lifecycle was never observed, mirroring
   * {@link BranchAssociatedPullRequestCandidate.lifecycleObserved} onto the
   * wire. Emitted ONLY when false — absent means observed, so every payload a
   * producer wrote before this field existed stays correct and unchanged.
   *
   * `state` is deliberately NOT widened to null here (an unobserved row still
   * reports the `OPEN` it read off its column default), so this flag is the only
   * thing that tells a renderer the state is not a reading. A client cannot
   * re-derive it: the LOC evidence fields that make a row observed are not on
   * this item.
   */
  lifecycleObserved?: boolean;
};

/** Additive all-known PR collection and deterministic default selection. */
export type BranchAssociatedPullRequestCollection = {
  items: readonly BranchAssociatedPullRequest[];
  selectedId: string | null;
  selectionReason: BranchAssociatedPullRequestSelectionReason;
  completeness: {
    state: BranchAssociatedPullRequestCompletenessState;
    reasons: readonly BranchAssociatedPullRequestCompletenessReason[];
    provenance: BranchAssociatedPullRequestProvenance;
  };
};

/** Persisted candidate shape accepted by the shared cloud/Desktop selector. */
export type BranchAssociatedPullRequestCandidate = {
  repositoryFullName: string | null;
  number: number | null;
  title: string | null;
  url: string | null;
  state: GitHubPRState | null;
  isDraft: boolean | null;
  reviewDecision: ReviewDecision | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  observedAt: string | null;
  /**
   * ISS-8422: `false` when the PRODUCER knows this row's lifecycle was never
   * observed — a persisted `pr_state` that is `NOT NULL` with a `@default(OPEN)`
   * and no lifecycle evidence behind it. Only a producer reading the raw row can
   * answer that, so the selector never infers it: absent or `true` means
   * observed, which is what every caller that omits the field gets.
   */
  lifecycleObserved?: boolean;
};

/** Shared selector output retains the original selected candidate for legacy projections. */
export type BranchAssociatedPullRequestSelection<
  Candidate extends BranchAssociatedPullRequestCandidate,
> = {
  collection: BranchAssociatedPullRequestCollection;
  selected: Candidate | null;
};

/**
 * Build the all-known associated-PR contract without consulting mutable current
 * pointers or cross-PR ingestion order. Observation time is used only to fold
 * repeated snapshots of the same canonical PR, including reopen cycles.
 */
export function selectBranchAssociatedPullRequests<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly Candidate[],
  provenance: BranchAssociatedPullRequestProvenance
): BranchAssociatedPullRequestSelection<Candidate> {
  const reasons = new Set<BranchAssociatedPullRequestCompletenessReason>();
  const candidatesById = new Map<string, NormalizedCandidate<Candidate>[]>();

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate, reasons);
    if (!normalized) {
      continue;
    }
    const duplicates = candidatesById.get(normalized.item.id) ?? [];
    duplicates.push(normalized);
    candidatesById.set(normalized.item.id, duplicates);
  }

  const normalizedCandidates: NormalizedCandidate<Candidate>[] = [];
  for (const duplicates of candidatesById.values()) {
    const resolved = resolveDuplicateSnapshots(duplicates, reasons);
    if (resolved) {
      normalizedCandidates.push(resolved);
    }
  }
  normalizedCandidates.sort(compareCanonicalPullRequests);

  // ISS-8422: "active" means a PR someone WATCHED being open. An unobserved row
  // reads Open off its column default, and counting it here is what let a stub
  // outrank a real merged sibling and drop that merge from the merge rate.
  const active = normalizedCandidates.filter(
    ({ item, unobserved }) => item.state === GitHubPRState.Open && !unobserved
  );
  const unobservedOpen = normalizedCandidates.filter(
    ({ item, unobserved }) => item.state === GitHubPRState.Open && unobserved
  );
  // Two unwitnessed open PRs are as ambiguous as two witnessed ones. Without
  // this, the last-resort pick below would surface whichever sorts first as THE
  // branch's PR and say nothing about the other.
  if (active.length > 1 || unobservedOpen.length > 1) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.MultipleActive);
  }

  const selected = selectCandidate(normalizedCandidates, active, reasons);
  const selectedId = selected?.item.id ?? null;
  const completenessState = completenessFor(
    candidates,
    normalizedCandidates,
    reasons
  );
  return {
    collection: {
      // The RESOLVED verdict, not the newest snapshot's: `unobserved` here has
      // already been folded across every duplicate of this PR, so an item whose
      // newest re-sync was factless but whose earlier snapshot carried evidence
      // is published as observed, agreeing with what selection used.
      items: normalizedCandidates.map(({ item, unobserved }) =>
        unobserved ? { ...item, lifecycleObserved: false } : item
      ),
      selectedId,
      selectionReason: selectionReasonFor(
        candidates,
        selected,
        active,
        reasons
      ),
      completeness: {
        state: completenessState,
        reasons: [...reasons].sort(),
        provenance,
      },
    },
    selected: selected?.candidate ?? null,
  };
}

type NormalizedCandidate<
  Candidate extends BranchAssociatedPullRequestCandidate,
> = {
  candidate: Candidate;
  item: BranchAssociatedPullRequest;
  observedEpoch: number | null;
  terminalEpoch: number | null;
  unobserved: boolean;
};

function normalizeCandidate<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidate: Candidate,
  reasons: Set<BranchAssociatedPullRequestCompletenessReason>
): NormalizedCandidate<Candidate> | null {
  const repositoryFullName = normalizedRepositoryIdentity(
    candidate.repositoryFullName
  );
  if (!(repositoryFullName && isValidPullRequestNumber(candidate.number))) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.InvalidIdentity);
    return null;
  }

  const lifecycle = normalizedLifecycle(candidate);
  if (!lifecycle) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle);
    return null;
  }
  if (hasInvalidTimestamp(candidate)) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.InvalidTimestamp);
  }
  const terminalEpoch = terminalEpochFor(candidate, lifecycle);
  if (lifecycle !== GitHubPRState.Open && terminalEpoch === null) {
    reasons.add(
      BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp
    );
  }

  const id = `${repositoryFullName}#${candidate.number}`;
  return {
    candidate,
    item: {
      id,
      repositoryFullName,
      number: candidate.number,
      title: candidate.title,
      url: candidate.url,
      state: lifecycle,
      isDraft: candidate.isDraft,
      reviewDecision: candidate.reviewDecision,
      openedAt: validIso(candidate.openedAt),
      closedAt: validIso(candidate.closedAt),
      mergedAt: validIso(candidate.mergedAt),
    },
    observedEpoch: isoEpoch(candidate.observedAt),
    terminalEpoch,
    unobserved: isUnobservedPullRequest(candidate),
  };
}

function resolveDuplicateSnapshots<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  duplicates: readonly NormalizedCandidate<Candidate>[],
  reasons: Set<BranchAssociatedPullRequestCompletenessReason>
): NormalizedCandidate<Candidate> | null {
  if (duplicates.length === 1) {
    return duplicates[0] ?? null;
  }
  const ordered = [...duplicates].sort(compareSnapshotRecency);
  const newest = ordered[0];
  if (!newest) {
    return null;
  }
  const hasUnrankableConflict = ordered.slice(1).some((snapshot) => {
    const observationsCannotOrder =
      newest.observedEpoch === null || snapshot.observedEpoch === null;
    const observationsAreTied = newest.observedEpoch === snapshot.observedEpoch;
    return (
      (observationsCannotOrder || observationsAreTied) &&
      !equivalentLifecycleSnapshot(newest.item, snapshot.item)
    );
  });
  if (hasUnrankableConflict) {
    reasons.add(
      BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate
    );
    return null;
  }
  return mergeCompatibleSnapshots(ordered);
}

function selectCandidate<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly NormalizedCandidate<Candidate>[],
  active: readonly NormalizedCandidate<Candidate>[],
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): NormalizedCandidate<Candidate> | null {
  if (active.length === 1 && !hasSelectionBlockingEvidence(reasons)) {
    return active[0] ?? null;
  }
  if (active.length > 0 || hasSelectionBlockingEvidence(reasons)) {
    return null;
  }
  if (
    reasons.has(
      BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp
    )
  ) {
    return null;
  }
  const terminal = candidates
    .filter(({ terminalEpoch }) => terminalEpoch !== null)
    .sort(compareTerminalSelection);
  if (terminal[0]) {
    return terminal[0];
  }
  // ISS-8422: nothing observed left to rank. An unwitnessed PR is still a real
  // pull request the user can open, so it is selected LAST rather than dropped
  // — the branch keeps its number and its link, and the read path reports a null
  // state rather than the schema default. `candidates` is already in canonical
  // order, so this stays deterministic.
  return candidates.find(({ unobserved }) => unobserved) ?? null;
}

function selectionReasonFor<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly Candidate[],
  selected: NormalizedCandidate<Candidate> | null,
  active: readonly NormalizedCandidate<Candidate>[],
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): BranchAssociatedPullRequestSelectionReason {
  if (selected?.unobserved) {
    return BranchAssociatedPullRequestSelectionReason.Unobserved;
  }
  if (selected?.item.state === GitHubPRState.Open) {
    return BranchAssociatedPullRequestSelectionReason.Active;
  }
  if (selected) {
    return BranchAssociatedPullRequestSelectionReason.MostRecentTerminal;
  }
  if (candidates.length === 0 && reasons.size === 0) {
    return BranchAssociatedPullRequestSelectionReason.None;
  }
  if (active.length > 1 || reasons.size > 0) {
    return BranchAssociatedPullRequestSelectionReason.Ambiguous;
  }
  return BranchAssociatedPullRequestSelectionReason.None;
}

function completenessFor<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly Candidate[],
  normalized: readonly NormalizedCandidate<Candidate>[],
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): BranchAssociatedPullRequestCompletenessState {
  if (reasons.size === 0) {
    return BranchAssociatedPullRequestCompletenessState.Complete;
  }
  if (candidates.length > 0 && normalized.length === 0) {
    return BranchAssociatedPullRequestCompletenessState.Unavailable;
  }
  return BranchAssociatedPullRequestCompletenessState.Incomplete;
}

function normalizedRepositoryIdentity(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = normalizeRepoFullName(value);
  return parseRepositoryFullName(normalized) ? normalized : null;
}

function normalizedLifecycle(
  candidate: BranchAssociatedPullRequestCandidate
): GitHubPRState | null {
  if (candidate.isDraft === true && candidate.state !== GitHubPRState.Open) {
    return null;
  }
  if (candidate.isDraft === true && validIso(candidate.mergedAt)) {
    return null;
  }
  if (validIso(candidate.mergedAt)) {
    return GitHubPRState.Merged;
  }
  if (
    !Object.values(GitHubPRState).includes(candidate.state as GitHubPRState)
  ) {
    return null;
  }
  return candidate.state;
}

function terminalEpochFor(
  candidate: BranchAssociatedPullRequestCandidate,
  lifecycle: GitHubPRState
): number | null {
  if (lifecycle === GitHubPRState.Merged) {
    return isoEpoch(candidate.mergedAt);
  }
  if (lifecycle === GitHubPRState.Closed) {
    return isoEpoch(candidate.closedAt);
  }
  return null;
}

function compareCanonicalPullRequests<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  left: NormalizedCandidate<Candidate>,
  right: NormalizedCandidate<Candidate>
): number {
  return (
    compareCodeUnits(
      left.item.repositoryFullName,
      right.item.repositoryFullName
    ) || left.item.number - right.item.number
  );
}

function compareTerminalSelection<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  left: NormalizedCandidate<Candidate>,
  right: NormalizedCandidate<Candidate>
): number {
  return (
    (right.terminalEpoch ?? Number.NEGATIVE_INFINITY) -
      (left.terminalEpoch ?? Number.NEGATIVE_INFINITY) ||
    compareCanonicalPullRequests(left, right)
  );
}

function compareSnapshotRecency<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  left: NormalizedCandidate<Candidate>,
  right: NormalizedCandidate<Candidate>
): number {
  return (
    (right.observedEpoch ?? Number.NEGATIVE_INFINITY) -
      (left.observedEpoch ?? Number.NEGATIVE_INFINITY) ||
    compareCodeUnits(JSON.stringify(left.item), JSON.stringify(right.item))
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function hasSelectionBlockingEvidence(
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): boolean {
  for (const reason of reasons) {
    if (SELECTION_BLOCKING_REASON[reason]) {
      return true;
    }
  }
  return false;
}

/**
 * Which completeness reasons suppress a default selection. Exhaustive over the
 * reason union BY CONSTRUCTION: this was a hand-written array of four of six
 * members, so a new reason silently took the non-blocking branch. A `Record`
 * cannot be written without naming every member, so the next one fails `tsc`
 * here (root AGENTS.md, side-inventory lesson).
 */
const SELECTION_BLOCKING_REASON: Record<
  BranchAssociatedPullRequestCompletenessReason,
  boolean
> = {
  [BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate]: true,
  [BranchAssociatedPullRequestCompletenessReason.InvalidIdentity]: true,
  [BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle]: true,
  [BranchAssociatedPullRequestCompletenessReason.InvalidTimestamp]: false,
  [BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp]: false,
  [BranchAssociatedPullRequestCompletenessReason.MultipleActive]: true,
};

function validIso(value: string | null): string | null {
  return isoEpoch(value) === null ? null : value;
}

function isoEpoch(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    return null;
  }
  return new Date(epoch).toISOString() === value ? epoch : null;
}

function isValidPullRequestNumber(value: number | null): value is number {
  return Number.isInteger(value) && (value ?? 0) > 0;
}

function hasInvalidTimestamp(
  candidate: BranchAssociatedPullRequestCandidate
): boolean {
  return [
    candidate.openedAt,
    candidate.closedAt,
    candidate.mergedAt,
    candidate.observedAt,
  ].some((value) => value !== null && isoEpoch(value) === null);
}

function equivalentLifecycleSnapshot(
  left: BranchAssociatedPullRequest,
  right: BranchAssociatedPullRequest
): boolean {
  return (
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.openedAt === right.openedAt &&
    left.closedAt === right.closedAt &&
    left.mergedAt === right.mergedAt
  );
}

function mergeCompatibleSnapshots<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  ordered: readonly NormalizedCandidate<Candidate>[]
): NormalizedCandidate<Candidate> {
  const newest = ordered[0];
  if (!newest) {
    throw new Error("Cannot merge an empty pull-request snapshot set");
  }
  const title = firstPresent(ordered, ({ item }) => item.title);
  const url = firstPresent(ordered, ({ item }) => item.url);
  const reviewDecision = firstPresent(
    ordered,
    ({ item }) => item.reviewDecision
  );
  // Observed if ANY snapshot of this PR was: a later unwitnessed re-sync must
  // not erase an earlier real observation.
  const unobserved = ordered.every((snapshot) => snapshot.unobserved);
  return {
    ...newest,
    unobserved,
    // The RESOLVED verdict has to travel on the candidate too, not just on this
    // wrapper. The candidate handed back to callers is the newest raw row, so a
    // consumer re-reading `lifecycleObserved` off it saw the newest snapshot's
    // answer while selection had already used the merged one — a factless
    // re-sync of a PR whose earlier snapshot carried LOC then selected as
    // observed and rendered as unobserved (davetho review on #6313).
    candidate: {
      ...newest.candidate,
      title,
      url,
      reviewDecision,
      lifecycleObserved: !unobserved,
    },
    item: {
      ...newest.item,
      title,
      url,
      reviewDecision,
    },
  };
}

function firstPresent<Value, Candidate>(
  values: readonly Candidate[],
  select: (candidate: Candidate) => Value | null
): Value | null {
  for (const value of values) {
    const selected = select(value);
    if (selected !== null) {
      return selected;
    }
  }
  return null;
}

/**
 * ISS-8422: the lifecycle state a consumer is allowed to believe.
 *
 * `state` is deliberately NOT widened to null for an unobserved pull request
 * (see {@link BranchAssociatedPullRequest.lifecycleObserved}), so it still
 * reports the `OPEN` the column default produced. Every reader that takes
 * `.state` at face value therefore restates that default as a measurement —
 * which is the whole defect — and the flag beside it is easy to miss. Read
 * this instead of the field, and the two cannot drift apart.
 *
 * Structurally typed on purpose: the cloud wire item, the desktop candidate and
 * the desktop cloud overlay carry these same two fields under three different
 * types, and all three need the identical fold.
 */
export function observedPullRequestState<State>(
  pullRequest: {
    state: State | null;
    lifecycleObserved?: boolean;
  } | null
): State | null {
  if (isUnobservedPullRequest(pullRequest)) {
    return null;
  }
  return pullRequest?.state ?? null;
}

/**
 * ISS-8422: whether NO producer has ever observed this pull request's lifecycle.
 *
 * The comparison is against `false` rather than a truthiness test, and naming it
 * is the point: `lifecycleObserved` is OPTIONAL and its ABSENCE means observed
 * (a version-skewed producer omits it entirely, and every payload written before
 * this field existed omits it), so `!pullRequest.lifecycleObserved` reads every
 * one of those as unobserved. One predicate is what stops each of this flag's
 * readers from writing that inversion independently.
 *
 * Structurally typed for the same reason {@link observedPullRequestState} is:
 * the cloud wire item, the desktop candidate and the desktop cloud overlay carry
 * the flag under three different types.
 */
export function isUnobservedPullRequest(
  pullRequest: { lifecycleObserved?: boolean } | null | undefined
): boolean {
  return pullRequest?.lifecycleObserved === false;
}

/**
 * Whether a short associated-pull-request collection actually HIDES a decided
 * pull request from a metric — a merge, or an unmerged close.
 *
 * ISS-9959: the Branches merge-rate and median-PR-size cards were starred by one
 * cohort-wide `every(...)`, so a single branch carrying any completeness reason
 * starred every window, permanently. Answering per window needs this question
 * kept apart from "is this collection perfect", because the common way a
 * collection is imperfect is a SELECTION ambiguity among pull requests the
 * producer read in full — which withholds nothing a decision metric counts.
 *
 * Deliberately NOT a question about time. A branch's latest known activity is no
 * upper bound on when an unread pull request was decided:
 * `MissingTerminalTimestamp` IS a decided pull request whose instant was never
 * read, and `buildPullRequestLifecycleActivityRecords` emits no terminal atom
 * when both terminal timestamps are absent, so the branch's last activity can
 * predate the very merge the shortfall is about.
 */
export function associatedPullRequestsWithholdDecisions(
  collection: BranchAssociatedPullRequestCollection
): boolean {
  const { state, reasons } = collection.completeness;
  if (state === BranchAssociatedPullRequestCompletenessState.Complete) {
    return false;
  }
  // An Unavailable collection states no reason, and `[].some(...)` is false:
  // reading an empty reason list as "nothing withheld" would clear a window for
  // the one state that resolved no candidate at all.
  if (reasons.length === 0) {
    return true;
  }
  if (reasons.some((reason) => DECISION_WITHHOLDING_REASON[reason])) {
    return true;
  }
  // The non-withholding set holds only while every candidate's lifecycle was
  // actually observed: an unobserved row reads OPEN off a column default
  // (ISS-8422), so "these are all still open" is not a reading, and the true
  // state behind it may be merged.
  return collection.items.some(isUnobservedPullRequest);
}

/**
 * Which completeness reasons withhold pull-request DECISION evidence.
 *
 * Exhaustive over the reason union BY CONSTRUCTION, for the same reason
 * {@link SELECTION_BLOCKING_REASON} is: a `Record` cannot be written without
 * naming every member, so a seventh reason fails `tsc` here instead of silently
 * taking the "withholds nothing" branch (root AGENTS.md, side-inventory lesson).
 *
 * `MultipleActive` is the only member that withholds nothing: every candidate it
 * describes is an OPEN pull request the producer read, carrying its own
 * timestamps, so the shortfall is about WHICH pull request represents the
 * branch, not about a decision nobody saw. Every other member either drops a
 * candidate outright or nulls the timestamp a decided pull request would have
 * been counted by.
 */
const DECISION_WITHHOLDING_REASON: Record<
  BranchAssociatedPullRequestCompletenessReason,
  boolean
> = {
  [BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate]: true,
  [BranchAssociatedPullRequestCompletenessReason.InvalidIdentity]: true,
  [BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle]: true,
  [BranchAssociatedPullRequestCompletenessReason.InvalidTimestamp]: true,
  [BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp]: true,
  [BranchAssociatedPullRequestCompletenessReason.MultipleActive]: false,
};

/**
 * ISS-12278: how a `GET /branches/[id]` caller wants the selected PR's checks.
 * `lazy` callers read them from `/branches/[id]/selected-pull-request/checks`;
 * a caller that omits the parameter (every installed build before this one)
 * still gets them inline on the detail.
 */
export const BranchDetailChecksDelivery = {
  Lazy: "lazy",
} as const;
export type BranchDetailChecksDelivery =
  (typeof BranchDetailChecksDelivery)[keyof typeof BranchDetailChecksDelivery];

/** Query accepted by `GET /branches/[id]`: the PR selection plus checks delivery. */
export const branchDetailQuerySchema = z
  .object({
    ...branchSelectedPullRequestQueryShape(),
    checks: z.enum(BranchDetailChecksDelivery).optional(),
  })
  .strict()
  .superRefine(requireWholeSelectedPullRequestIdentity);
export type BranchDetailQuery = z.infer<typeof branchDetailQuerySchema>;

function branchSelectedPullRequestQueryShape() {
  return {
    repositoryFullName: selectedPullRequestRepositoryFullNameSchema.optional(),
    pullRequestNumber: selectedPullRequestNumberSchema.optional(),
  };
}

function requireWholeSelectedPullRequestIdentity(
  value: { repositoryFullName?: string; pullRequestNumber?: number },
  context: z.RefinementCtx
): void {
  if (
    (value.repositoryFullName === undefined) !==
    (value.pullRequestNumber === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "repositoryFullName and pullRequestNumber must be provided together",
    });
  }
}

/**
 * A draft closed without merging. Operator ruling 2026-10-14 (ISS-12421
 * session, resolving the #8791 disagreement): Merge rate and Median PR size
 * exclude it, and it does not star either card. The selector still reads it as
 * an invalid lifecycle for the branch's own PR collection and status.
 */
export function isClosedUnmergedDraft(
  candidate: Pick<
    BranchAssociatedPullRequestCandidate,
    "isDraft" | "state" | "mergedAt"
  >
): boolean {
  return (
    candidate.isDraft === true &&
    candidate.state === GitHubPRState.Closed &&
    !candidate.mergedAt
  );
}

/**
 * The associated-PR collection over the candidates the PR metrics count, so an
 * excluded closed draft cannot make a branch's metric evidence incomplete.
 */
export function metricAssociatedPullRequestCollection(
  candidates: readonly BranchAssociatedPullRequestCandidate[],
  provenance: BranchAssociatedPullRequestProvenance
): BranchAssociatedPullRequestCollection {
  return selectBranchAssociatedPullRequests(
    candidates.filter((candidate) => !isClosedUnmergedDraft(candidate)),
    provenance
  ).collection;
}
