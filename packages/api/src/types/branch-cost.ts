/**
 * Additive Branch cost wire contracts shared by cloud and Desktop producers.
 *
 * The legacy estimated field keeps its raw replicated meaning for version-skewed
 * consumers. Canonical per-branch presentation reads the attributed field, which
 * splits every session's captured cost across its global active-write branches.
 */
export type BranchCostFields = {
  /**
   * Raw per-branch cost: every linked session's whole captured cost, once for
   * this branch. A session shared by N branches therefore appears in full on
   * every row. This compatibility field must not be changed to even-split
   * semantics because older clients use it when additive cost fields are absent.
   * Cloud's legacy compatibility projection also preserves its historical
   * null-on-zero behavior; use `attributedCostUsd` to distinguish a canonical
   * priced zero from unavailable cost.
   */
  estimatedCostUsd: number | null;
  /**
   * Canonical per-branch cost: every linked session's captured cost divided by
   * its global active-write branch count. Shares across branches reconcile to
   * the session's cost exactly once. Optional for version-skew compatibility;
   * upgraded consumers prefer it and fall back to `estimatedCostUsd` when absent.
   * `null` means no linked session has priced usage.
   */
  attributedCostUsd?: number | null;
};

/** Session-level cost evidence used to reconcile a Branch's attributed total. */
export type BranchSessionCostFields = {
  /** Whole captured cost for this session; `null` when unpriced. */
  estimatedCostUsd: number | null;
  /**
   * This session's cost share for the current branch. Optional for legacy
   * producers and `null` when the session is unpriced.
   */
  evenSplitCostUsd?: number | null;
  /**
   * Global active-write branch count used as the even-split divisor. Missing or
   * non-positive values are treated as one by compatibility consumers.
   */
  branchCount?: number;
};

/**
 * Resolves the canonical cost attributable to one branch. Upgraded producers
 * send `attributedCostUsd`; older producers omit it and retain the legacy raw
 * `estimatedCostUsd` behavior. Explicit `null` and zero are authoritative and
 * therefore must not fall back to the raw compatibility total.
 */
export function resolveAttributedBranchCost(
  cost: BranchCostFields
): number | null {
  if (cost.attributedCostUsd !== undefined) {
    return cost.attributedCostUsd;
  }
  return cost.estimatedCostUsd;
}
