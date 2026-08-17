import "server-only";

import { getInstallationOctokit } from "@repo/github/installation-auth";
import pLimit from "p-limit";
import {
  classifyComponentPath,
  dedupeComponents,
  isComponentCandidatePath,
  type ParsedComponent,
} from "./pack-component-parse";

/** Cap blob fetches so a huge repo can't fan out unbounded GitHub reads. */
const MAX_COMPONENT_FILES = 300;

/**
 * Cap on in-flight blob fetches. Each candidate is an independent GitHub read,
 * so we fan them out concurrently instead of paying N serial round-trips, but
 * bound the concurrency to keep GitHub rate-limit pressure in check. Mirrors the
 * `PR_READ_REPAIR_CONCURRENCY = 5` cap used for GitHub reads in
 * apps/api/lib/pr-read-repair.ts.
 */
const BLOB_FETCH_CONCURRENCY = 5;

const TRIM_SLASHES_RE = /^\/+|\/+$/g;

/**
 * Thrown when GitHub truncates the recursive tree response (very large repos).
 * A truncated tree would silently drop components, so we fail the import with a
 * clear, actionable error instead of importing a partial, non-deterministic set.
 */
export class RepoTreeTruncatedError extends Error {
  constructor(owner: string, repo: string) {
    super(
      `GitHub returned a truncated file tree for ${owner}/${repo}; the repository is too large to import in full. Narrow the import with a subPath (e.g. \`.claude\`).`
    );
    this.name = "RepoTreeTruncatedError";
  }
}

/**
 * Thrown when the number of candidate component files exceeds
 * {@link MAX_COMPONENT_FILES}. Silently slicing to the cap would import a
 * partial, order-dependent subset without any signal, so — mirroring the
 * tree-truncation invariant — we fail loudly with the same actionable guidance
 * (narrow the import with a subPath) instead of importing an incomplete set.
 */
export class RepoComponentsTruncatedError extends Error {
  constructor(
    owner: string,
    repo: string,
    totalCandidates: number,
    cap: number
  ) {
    super(
      `Found ${totalCandidates} candidate component files in ${owner}/${repo}, which exceeds the import cap of ${cap}. Narrow the import with a subPath (e.g. \`.claude\`) so no components are silently dropped.`
    );
    this.name = "RepoComponentsTruncatedError";
  }
}

export type RepoSource = {
  installationId: string;
  owner: string;
  repo: string;
  /** Git ref (branch/tag/sha); defaults to the repo's default branch. */
  ref?: string;
  /** Only import under this subdirectory (e.g. `.claude` or `shared/assets`). */
  subPath?: string;
};

function normalizeSubPath(subPath?: string): string {
  if (!subPath) {
    return "";
  }
  const trimmed = subPath.replace(TRIM_SLASHES_RE, "");
  return trimmed ? `${trimmed}/` : "";
}

/**
 * Read a repository's tree (canonical Claude Code layout) via the org's GitHub
 * App installation and classify the recognized files into components. Only
 * candidate paths have their blob content fetched.
 */
export async function fetchRepoComponents(
  source: RepoSource
): Promise<ParsedComponent[]> {
  const octokit = await getInstallationOctokit(source.installationId);
  const { owner, repo } = source;

  let ref = source.ref;
  if (!ref) {
    const info = await octokit.repos.get({ owner, repo });
    ref = info.data.default_branch;
  }

  const tree = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: "true",
  });
  // GitHub caps recursive tree responses; a truncated tree would silently drop
  // components, so fail loudly rather than importing an incomplete set.
  if (tree.data.truncated) {
    throw new RepoTreeTruncatedError(owner, repo);
  }
  const prefix = normalizeSubPath(source.subPath);

  const candidates = tree.data.tree.flatMap((entry) => {
    if (
      entry.type !== "blob" ||
      typeof entry.path !== "string" ||
      typeof entry.sha !== "string"
    ) {
      return [];
    }
    if (prefix && !entry.path.startsWith(prefix)) {
      return [];
    }
    const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
    return isComponentCandidatePath(rel) ? [{ sha: entry.sha, rel }] : [];
  });

  // Candidates over the cap would previously be silently sliced away, importing
  // a partial, order-dependent subset with no signal. Mirror the tree-truncation
  // invariant and fail loudly before fetching any blobs so the admin gets
  // actionable guidance (narrow with a subPath) instead of a false success.
  if (candidates.length > MAX_COMPONENT_FILES) {
    throw new RepoComponentsTruncatedError(
      owner,
      repo,
      candidates.length,
      MAX_COMPONENT_FILES
    );
  }

  // Each candidate blob fetch is an independent GitHub round-trip, so fan them
  // out concurrently (bounded by BLOB_FETCH_CONCURRENCY) rather than paying up
  // to MAX_COMPONENT_FILES serial round-trips. `allSettled` (not `all`) so no
  // fetch outlives this function: `all` would reject on the first failure while
  // the queued and in-flight tasks kept running unawaited, which the
  // fire-and-forget rule in apps/api/AGENTS.md forbids. The original loop's
  // fail-fast behavior is kept explicitly instead: `aborted` stops any
  // not-yet-started fetch, and the first rejection in candidate order is
  // rethrown once every task has settled.
  const limit = pLimit(BLOB_FETCH_CONCURRENCY);
  let aborted = false;
  const settled = await Promise.allSettled(
    candidates.map((candidate) =>
      limit(async () => {
        if (aborted) {
          return null;
        }
        try {
          const blob = await octokit.git.getBlob({
            owner,
            repo,
            file_sha: candidate.sha,
          });
          const content = Buffer.from(
            blob.data.content,
            (blob.data.encoding as BufferEncoding) ?? "base64"
          ).toString("utf-8");
          return classifyComponentPath(candidate.rel, () => content);
        } catch (error) {
          aborted = true;
          throw error;
        }
      })
    )
  );

  for (const result of settled) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  const components: ParsedComponent[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      components.push(...result.value);
    }
  }

  return dedupeComponents(components);
}
