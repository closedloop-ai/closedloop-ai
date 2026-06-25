/**
 * Canonical PR identity derivation for the Branches live overlays (Epic F /
 * FEA-1952). Both the files overlay (F1) and the status overlay (F2) key on the
 * same `owner`/`repo`/`prNumber`, fetched slug-only via `gh` (no local checkout
 * needed), so they resolve identity through this one helper.
 */

export type PrIdentity = { owner: string; repo: string; prNumber: number };

export type PrIdentityInput = {
  repoFullName: string | null;
  prNumber: number | null;
  /** >1 linked PR → ambiguous attribution; gate the overlay entirely. */
  multiPrWarning: boolean;
};

/**
 * Split a branch's `repoFullName` ("owner/name") + `prNumber` into a PR identity.
 * Returns null (overlay gated) when there is a multi-PR warning, no repo
 * identity, no PR, or `repoFullName` is not a clean `"owner/name"` pair (a
 * short-name form must gate rather than mis-split — open question #2).
 */
export function derivePrIdentity(input: PrIdentityInput): PrIdentity | null {
  if (
    input.multiPrWarning ||
    input.repoFullName === null ||
    input.prNumber === null
  ) {
    return null;
  }
  const parts = input.repoFullName.split("/");
  if (parts.length !== 2 || !(parts[0] && parts[1])) {
    return null;
  }
  return { owner: parts[0], repo: parts[1], prNumber: input.prNumber };
}
