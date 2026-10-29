/**
 * ISS-8972 (davetho review) — how many per-Session membership entries ONE
 * branch may publish into the list projection.
 *
 * The list's page bound limits BRANCHES, not the Sessions attached to any one of
 * them, and the link read/fold has no per-branch cap. So a single heavily-linked
 * branch could put an unbounded array into every list response and hand the
 * renderer an unbounded chip set — the response grows with a branch's history
 * rather than with the page.
 *
 * THE COUNT IS NOT CAPPED. `membership.sessionIds` and `qualifyingSessionCount`
 * stay complete, so nothing downstream loses the true number; only the detailed
 * entries are bounded. A branch over the limit therefore has more Sessions than
 * described entries. The renderer may show its smaller display-capped chip set
 * beside the complete count; when it cannot safely describe any entry, it falls
 * back to the count chip. Either treatment keeps the uncapped total truthful.
 *
 * It also bounds the owner-identity predicate: the list resolves owner profiles
 * only for the Sessions it will actually publish, so widening that read cannot
 * scale with a branch's total link count (whitlockk review).
 *
 * A leaf module with no imports so the projection and the identity read can
 * share the number without either importing the other.
 */
export const BRANCH_MEMBERSHIP_SESSION_LIMIT = 50;
