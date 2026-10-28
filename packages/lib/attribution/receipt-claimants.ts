/**
 * ISS-12552 (PRD-800 "Proving usage"; PLN-2191 fork rule): which of an
 * owner's claims for one receipt keeps it. Sync binding, the late receipt
 * binder and the historical backfill settle a receipt through this module, so
 * all three reach the same holder whichever runs first.
 *
 * Copies (same harness and external session id) are one session: the copy on
 * the lowest compute target id keeps the receipt. Between different sessions
 * (a fork and its parent) the claim invoked first keeps it; a fork copies its
 * parent's calls with their call times, so when the call times tie, the
 * session that started strictly earlier (the parent, as for tokens) keeps it.
 * When the start times tie too, nothing says which is the copy, so every claim
 * contests the receipt and none holds it. A receipt two sessions match only by
 * request fingerprint is never bound: a fingerprint does not prove which
 * session made the call.
 */
import { canonicalCopy, type SessionCopyIdentity } from "./transcript-copies";

/** The two times the fork rule reads from a claim. */
export type ForkSide = {
  invokedAt: Date | null;
  sessionStartedAt: Date | null;
};

export const ClaimPrecedence = {
  /** The first claim keeps the receipt. */
  First: "first",
  /** The second claim keeps it. */
  Second: "second",
  /** Neither can be named the original. */
  Tied: "tied",
} as const;
export type ClaimPrecedence =
  (typeof ClaimPrecedence)[keyof typeof ClaimPrecedence];

/**
 * The fork rule between claims in two different sessions of one owner. A claim
 * with no call time never proves it came first, so the other keeps the
 * receipt; when neither has one, `second` (the holder, for a caller comparing
 * a claim with the row holding the receipt) keeps it.
 */
export function claimPrecedence(
  first: ForkSide,
  second: ForkSide
): ClaimPrecedence {
  const firstAt = first.invokedAt?.getTime() ?? null;
  const secondAt = second.invokedAt?.getTime() ?? null;
  if (firstAt !== null && firstAt === secondAt) {
    const firstStart = first.sessionStartedAt?.getTime() ?? null;
    const secondStart = second.sessionStartedAt?.getTime() ?? null;
    if (
      firstStart === null ||
      secondStart === null ||
      firstStart === secondStart
    ) {
      return ClaimPrecedence.Tied;
    }
    return firstStart < secondStart
      ? ClaimPrecedence.First
      : ClaimPrecedence.Second;
  }
  return firstAt !== null && (secondAt === null || firstAt < secondAt)
    ? ClaimPrecedence.First
    : ClaimPrecedence.Second;
}

/** One claim an owner's session holds for a receipt. */
export type ReceiptClaimant = ForkSide & {
  agentSessionId: string;
  session: SessionCopyIdentity;
  /** The claim names the receipt by call id or operation id, not only by fingerprint. */
  byIdentity: boolean;
};

export type ClaimantResolution<T> = {
  /** The claim that binds the receipt, when one does. */
  holder?: T;
  /** Claims that yield to the holder, as later copies or later forks. */
  duplicates: T[];
  /** Claims that keep contesting the receipt, so none of them can take it. */
  contested: T[];
};

/**
 * Settles one receipt among the owner's claims for it. Null when one session
 * holds two of them: which of its own calls made the write is unknown, so
 * nothing is settled.
 */
export function resolveReceiptClaimants<T extends ReceiptClaimant>(
  claimants: readonly T[]
): ClaimantResolution<T> | null {
  const sessions = new Set(claimants.map((claim) => claim.agentSessionId));
  if (claimants.length === 0 || sessions.size !== claimants.length) {
    return null;
  }
  const groups = new Map<string, T[]>();
  for (const claim of claimants) {
    const key = `${claim.session.harness}\u0000${claim.session.externalSessionId}`;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  const representatives = [...groups.values()].flatMap(
    (group) =>
      canonicalCopy(group, (claim) => claim.session.computeTargetId) ?? []
  );
  const holder =
    representatives.length === 1
      ? representatives[0]
      : forkHolder(representatives, claimants);
  if (!holder) {
    return { duplicates: [], contested: [...claimants] };
  }
  return {
    holder,
    duplicates: claimants.filter((claim) => claim !== holder),
    contested: [],
  };
}

/** The one session whose claim precedes every other session's, if any. */
function forkHolder<T extends ReceiptClaimant>(
  representatives: readonly T[],
  claimants: readonly T[]
): T | undefined {
  if (!claimants.every((claim) => claim.byIdentity)) {
    return undefined;
  }
  return representatives.find((candidate) =>
    representatives.every(
      (other) =>
        other === candidate ||
        claimPrecedence(candidate, other) === ClaimPrecedence.First
    )
  );
}
