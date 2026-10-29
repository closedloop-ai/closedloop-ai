import { describe, expect, it } from "vitest";
import type { WireTreeTruncationReason } from "../project-tree";
import {
  isProjectTreeTruncated,
  orderTreeTruncationReasons,
  TreeTruncationReason,
} from "../project-tree";

describe("orderTreeTruncationReasons", () => {
  it("dedupes and emits the stable contract order", () => {
    expect(
      orderTreeTruncationReasons([
        TreeTruncationReason.NodeBudget,
        TreeTruncationReason.AnchorCap,
        TreeTruncationReason.NodeBudget,
        TreeTruncationReason.DepthCap,
      ])
    ).toEqual([
      TreeTruncationReason.AnchorCap,
      TreeTruncationReason.DepthCap,
      TreeTruncationReason.NodeBudget,
    ]);
  });

  it("keeps a reason this build does not know, rather than dropping it", () => {
    // A client running behind a server that grew a fourth reason must not fold
    // a truncated read down to an empty `reasons` — that is exactly the
    // "complete" claim `isProjectTreeTruncated` would then make.
    // No cast: a reason a newer server sends is a real wire value, so the type
    // the helper and `TreeTruncation.reasons` speak has to admit it.
    const future = "future_cap";
    const ordered = orderTreeTruncationReasons([
      future,
      TreeTruncationReason.DepthCap,
    ]);

    expect(ordered).toEqual([TreeTruncationReason.DepthCap, future]);
    expect(isProjectTreeTruncated({ truncation: truncationOf(ordered) })).toBe(
      true
    );
  });

  // `reasons` is contractually comparable across requests, and a `Set` keeps
  // INSERTION order — so unknown reasons left unsorted would order by whichever
  // project's tree the client merged first, and the same truncated set would
  // read differently between two responses.
  it("orders unknown reasons independently of the order they arrived in", () => {
    const forward = orderTreeTruncationReasons([
      "zeta_cap",
      TreeTruncationReason.NodeBudget,
      "alpha_cap",
      TreeTruncationReason.AnchorCap,
    ]);

    expect(forward).toEqual([
      TreeTruncationReason.AnchorCap,
      TreeTruncationReason.NodeBudget,
      "alpha_cap",
      "zeta_cap",
    ]);
    expect(
      orderTreeTruncationReasons([
        TreeTruncationReason.AnchorCap,
        "alpha_cap",
        TreeTruncationReason.NodeBudget,
        "zeta_cap",
      ])
    ).toEqual(forward);
  });

  it("is empty only when it was given nothing", () => {
    expect(orderTreeTruncationReasons([])).toEqual([]);
  });
});

function truncationOf(reasons: WireTreeTruncationReason[]) {
  return { anchorsIncluded: 1, anchorsMatchedAtLeast: 2, reasons };
}
