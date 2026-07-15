import "server-only";

import { getInstallationOctokit } from "@repo/github/installation-auth";
import {
  classifyComponentPath,
  dedupeComponents,
  isComponentCandidatePath,
  type ParsedComponent,
} from "./pack-component-parse";

/** Cap blob fetches so a huge repo can't fan out unbounded GitHub reads. */
const MAX_COMPONENT_FILES = 300;

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

  const components: ParsedComponent[] = [];
  for (const candidate of candidates) {
    const blob = await octokit.git.getBlob({
      owner,
      repo,
      file_sha: candidate.sha,
    });
    const content = Buffer.from(
      blob.data.content,
      (blob.data.encoding as BufferEncoding) ?? "base64"
    ).toString("utf-8");
    const parsed = classifyComponentPath(candidate.rel, () => content);
    if (parsed) {
      components.push(...parsed);
    }
  }

  return dedupeComponents(components);
}
