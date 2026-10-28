import {
  BranchStatus,
  type BranchStatus as BranchStatusValue,
  PrState,
  type PrState as PrStateValue,
  type SelectedPullRequest,
} from "./mock";

export const BranchDurationOutcome = {
  Abandoned: "abandoned",
  InFlight: "in_flight",
  Merged: "merged",
} as const;
export type BranchDurationOutcome =
  (typeof BranchDurationOutcome)[keyof typeof BranchDurationOutcome];

export type BranchDurationInput = {
  status: BranchStatusValue | string | null | undefined;
  prState: PrStateValue | string | null | undefined;
  selectedPullRequest?: Pick<SelectedPullRequest, "state"> | null;
  merged?: boolean;
};

/** Classifies prototype Branch status for list metrics and terminal-duration rules. */
export function branchActiveState(
  status: BranchStatusValue | string | null | undefined
): boolean | null {
  switch (status) {
    case BranchStatus.Merged:
    case BranchStatus.Closed:
    case BranchStatus.Canceled:
      return false;
    case BranchStatus.Open:
    case BranchStatus.Draft:
    case BranchStatus.Review:
    case BranchStatus.Blocked:
      return true;
    default:
      return null;
  }
}

/** Resolves the Branch duration metric family without duplicating status predicates. */
export function resolveBranchDurationOutcome(
  input: BranchDurationInput
): BranchDurationOutcome {
  const selectedPrState = input.selectedPullRequest?.state ?? null;
  if (selectedPrState === PrState.Merged) {
    return BranchDurationOutcome.Merged;
  }
  if (
    input.status === BranchStatus.Merged ||
    input.prState === PrState.Merged ||
    input.merged === true
  ) {
    return BranchDurationOutcome.Merged;
  }
  if (input.status === BranchStatus.Canceled) {
    return BranchDurationOutcome.Abandoned;
  }
  if (selectedPrState === PrState.Closed) {
    return BranchDurationOutcome.Abandoned;
  }
  if (selectedPrState === PrState.Open) {
    return BranchDurationOutcome.InFlight;
  }
  if (
    input.status === BranchStatus.Closed ||
    input.prState === PrState.Closed
  ) {
    return BranchDurationOutcome.Abandoned;
  }
  return BranchDurationOutcome.InFlight;
}

/** Returns the terminal endpoint label shown in the Branch duration waterfall. */
export function branchDurationOutcomeLabel(
  input: BranchDurationInput
): "Canceled" | "Closed" | "Merged" | "Open" {
  const outcome = resolveBranchDurationOutcome(input);
  if (outcome === BranchDurationOutcome.Merged) {
    return "Merged";
  }
  if (outcome === BranchDurationOutcome.Abandoned) {
    return input.status === BranchStatus.Canceled ? "Canceled" : "Closed";
  }
  return "Open";
}
