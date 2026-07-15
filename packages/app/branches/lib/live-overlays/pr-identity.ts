/**
 * Canonical PR identity derivation for the Branches live overlays (Epic F /
 * FEA-1952). Both the files overlay (F1) and the status overlay (F2) key on the
 * same `owner`/`repo`/`prNumber`, fetched slug-only via `gh` (no local checkout
 * needed), so they resolve identity through this one helper.
 */

export type PrIdentity = { owner: string; repo: string; prNumber: number };

export type PrIdentityInput = {
  repoFullName: string | null;
  /** GitHub PR URL fallback used when local branch repo identity is missing. */
  prUrl?: string | null;
  prNumber: number | null;
  /** >1 linked PR → ambiguous attribution; gate the overlay entirely. */
  multiPrWarning: boolean;
};

/**
 * Split a branch's persisted PR fields into a live-overlay identity. Prefer the
 * branch repo identity when it is a clean `owner/name`; otherwise fall back to
 * the linked GitHub PR URL. Repo-less local branch ids can still carry a PR URL,
 * and the desktop gateway can safely resolve `/pr/files` from that slug.
 */
export function derivePrIdentity(input: PrIdentityInput): PrIdentity | null {
  if (input.multiPrWarning || input.prNumber === null) {
    return null;
  }
  const repoIdentity = splitRepoFullName(input.repoFullName);
  if (repoIdentity) {
    return { ...repoIdentity, prNumber: input.prNumber };
  }
  return parseGithubPrUrl(input.prUrl ?? null, input.prNumber);
}

const SAFE_SLUG_SEGMENT_REGEX = /^[A-Za-z0-9._-]+$/;

function splitRepoFullName(
  repoFullName: string | null
): { owner: string; repo: string } | null {
  if (repoFullName === null) {
    return null;
  }
  const parts = repoFullName.split("/");
  if (
    parts.length !== 2 ||
    !isSafeSlugSegment(parts[0]) ||
    !isSafeSlugSegment(parts[1])
  ) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function parseGithubPrUrl(
  prUrl: string | null,
  expectedPrNumber: number
): PrIdentity | null {
  if (!prUrl) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull") {
    return null;
  }
  const [owner, repo, , prNumberPart] = parts;
  if (
    !(
      isSafeSlugSegment(owner) &&
      isSafeSlugSegment(repo) &&
      prNumberPart === String(expectedPrNumber)
    )
  ) {
    return null;
  }
  return { owner, repo, prNumber: expectedPrNumber };
}

function isSafeSlugSegment(value: string | undefined): value is string {
  return value !== undefined && SAFE_SLUG_SEGMENT_REGEX.test(value);
}
