/**
 * The word a Branches cell renders for a value that is absent: an enrichment
 * its producer did not serve (an older API or Desktop build), or line counts a
 * branch has none of.
 * One component rather than a span re-typed per cell (ISS-10332 review), so the
 * priority cell and the grid adapter's four sites cannot drift from each other
 * on the word or its muted/xs pairing.
 */
export const BRANCH_UNAVAILABLE_LABEL = "Unavailable";

export function BranchUnavailableValue() {
  return (
    <span className="text-muted-foreground text-xs">
      {BRANCH_UNAVAILABLE_LABEL}
    </span>
  );
}
