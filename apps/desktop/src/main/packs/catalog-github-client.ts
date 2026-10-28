/**
 * @file catalog-github-client.ts — the GitHub transport the Agent Pack Catalog
 * fetch runs on (FEA-1314 / PLN-657), split out of `catalog-fetcher.ts` by
 * ISS-5274.
 *
 * Everything here is network + parsing only: no database, no scheduling, no
 * per-row policy. That is what lets the catalog fetch's I/O move OFF the
 * db-host — `collectCatalogFetchPlan` calls these from the main process, while
 * the db-host is left with the bounded read and the writes.
 *
 * Unauthenticated REST is the only transport (`https://api.github.com/...`).
 * Rate limits are an expected unavailable-transport state, not a reason to
 * resolve or spawn the user's `gh` binary from the catalog path.
 *
 * Every call is best-effort and returns null rather than throwing: a single
 * pack's 404 or rate-limit must never fail the run.
 */

import https from "node:https";

const REQUEST_TIMEOUT_MS = 5000;
const USER_AGENT = "closedloop-electron-agent-monitor";

/**
 * Owner and repo segments, matching what GitHub actually permits in a name:
 * ASCII letters, digits, `_`, `-` and `.` (that is `[\w.-]`).
 *
 * ISS-7951 — the dot is load-bearing. The repo segment used to be `[^/?#.]+`,
 * which stops at the FIRST dot, so `vercel/next.js` parsed to `next`, every
 * lookup for it 404'd, and the 404 resolved to null: the pack rendered with no
 * stars and no forks and nothing reported that the lookup had been malformed.
 * Dotted names are ordinary (`next.js`, `socket.io`, `three.js`).
 *
 * A segment still ends at `/`, `?` or `#`, so a `/tree/main` suffix, a query
 * string and a fragment all stay out of the capture.
 *
 * ANCHORED, and the anchoring is the second half of the fix. Unanchored, this
 * matched `github.com` ANYWHERE in the string, so `https://notgithub.com/a/b`
 * and `https://evil.example/mirror/github.com/a/b` both parsed to `a/b` and the
 * catalog then fetched — or scraped — a repository the row never named. The
 * trailing `(?=$|[/?#])` is the other half: without a boundary the class simply
 * stops at the first character it does not admit, so
 * `github.com/acme/widgets%2Fprivate` silently truncated to `widgets` and hit
 * the real `acme/widgets`. Both now return null, which is a logged skip.
 */
const GITHUB_URL_PATTERN =
  /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+)(?=$|[/?#])/;
/**
 * `[\w.-]` admits a segment that is nothing but dots, which GitHub permits as
 * neither an owner nor a repository name and which would traverse the REST path
 * this parser's output is interpolated into (`/repos/../x`).
 */
const DOTS_ONLY_SEGMENT = /^\.+$/;
/**
 * Now that the repo segment admits dots, `owner/repo.git` reaches this strip
 * instead of being truncated before it — which is why the strip is kept rather
 * than deleted as the dead code it was. It cannot eat a real name: GitHub
 * rejects a repository whose name ends in `.git`, so the suffix is always the
 * clone-URL decoration.
 */
const TRAILING_DOT_GIT = /\.git$/;

export type ParsedRepo = {
  owner: string;
  repo: string;
};

export type GitHubRepoResponse = {
  stargazers_count?: number;
  forks_count?: number;
  description?: string;
};

type GitHubReleaseResponse = {
  tag_name?: string;
  name?: string;
};

export type PluginManifest = {
  description?: string;
  version?: string;
};

export const GitHubJsonFetchStatus = {
  Success: "success",
  NotFound: "not_found",
  Unavailable: "unavailable",
} as const;

export type GitHubJsonFetchStatus =
  (typeof GitHubJsonFetchStatus)[keyof typeof GitHubJsonFetchStatus];

export type GitHubJsonFetchResult<T> =
  | { status: typeof GitHubJsonFetchStatus.Success; value: T }
  | { status: typeof GitHubJsonFetchStatus.NotFound; value: null }
  | { status: typeof GitHubJsonFetchStatus.Unavailable; value: null };

/**
 * Parse owner/repo out of a github URL. The forms accepted, in full:
 *   https://github.com/owner/repo            -> { owner, repo }
 *   https://github.com/owner/repo/           -> { owner, repo }
 *   https://github.com/owner/repo.git        -> { owner, repo }
 *   https://github.com/owner/repo/tree/main  -> { owner, repo }
 *   https://github.com/owner/repo?tab=readme -> { owner, repo }
 *   https://github.com/owner/repo#install    -> { owner, repo }
 *   https://github.com/owner/repo.name       -> { owner, repo: "repo.name" }
 *   git@github.com:owner/repo.git            -> { owner, repo }
 *
 * That list is exhaustive, and a `github.com` host is required in every entry
 * of it. A BARE `owner/repo` is deliberately NOT accepted: the one caller that
 * holds one is `marketplaceSourceRepo`, which wraps it in
 * `https://github.com/` before calling here, and accepting it unwrapped would
 * make every two-segment string on earth a GitHub repository.
 *
 * A catalog `github_url` is external input, so anything else — a non-GitHub
 * host, a lookalike host, a `github.com` buried in some other URL's path, a
 * bare owner with no repo, a segment carrying characters GitHub does not allow
 * in a name — returns null rather than a truncated guess. Callers MUST treat
 * that null as a diagnosable skip, not as "this pack has no repo".
 */
export function parseGithubUrl(
  url: string | null | undefined
): ParsedRepo | null {
  if (typeof url !== "string") {
    return null;
  }
  const m = url.match(GITHUB_URL_PATTERN);
  if (!m) {
    return null;
  }
  const owner = m[1];
  const repo = m[2].replace(TRAILING_DOT_GIT, "");
  if (!repo || DOTS_ONLY_SEGMENT.test(owner) || DOTS_ONLY_SEGMENT.test(repo)) {
    return null;
  }
  return { owner, repo };
}

export function fetchGithubJson<T = unknown>(
  urlPath: string,
  accept = "application/vnd.github+json"
): Promise<T | null> {
  return fetchGithubJsonResult<T>(urlPath, accept).then((result) =>
    result.status === GitHubJsonFetchStatus.Success ? result.value : null
  );
}

export function fetchGithubJsonResult<T = unknown>(
  urlPath: string,
  accept = "application/vnd.github+json"
): Promise<GitHubJsonFetchResult<T>> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: "api.github.com",
        path: urlPath,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve({
                status: GitHubJsonFetchStatus.Success,
                value: JSON.parse(body) as T,
              });
            } catch {
              resolve(githubJsonUnavailable());
            }
          } else if (res.statusCode === 404) {
            resolve({ status: GitHubJsonFetchStatus.NotFound, value: null });
          } else {
            resolve(githubJsonUnavailable());
          }
        });
      }
    );
    req.on("error", () => resolve(githubJsonUnavailable()));
    req.on("timeout", () => {
      req.destroy();
      resolve(githubJsonUnavailable());
    });
  });
}

function restFetch(
  owner: string,
  repo: string
): Promise<GitHubJsonFetchResult<GitHubRepoResponse>> {
  return fetchGithubJsonResult<GitHubRepoResponse>(`/repos/${owner}/${repo}`);
}

async function restFetchLatestRelease(
  owner: string,
  repo: string
): Promise<LatestReleaseFetchResult> {
  const parsed = await fetchGithubJsonResult<GitHubReleaseResponse>(
    `/repos/${owner}/${repo}/releases/latest`
  );
  if (parsed.status === GitHubJsonFetchStatus.NotFound) {
    return { available: true, release: null };
  }
  if (parsed.status === GitHubJsonFetchStatus.Unavailable) {
    return { available: false, release: null };
  }
  return { available: true, release: releaseLabel(parsed.value) };
}

/**
 * Fetch a marketplace sub-plugin's .claude-plugin/plugin.json from the
 * parent marketplace repo. Returns the parsed JSON or null. Used to source
 * plugin-specific description + version for catalog entries whose
 * `contents.type === 'github-claude-plugin'`.
 */
function restFetchPluginManifest(
  owner: string,
  repo: string,
  pluginPath: string
): Promise<PluginManifest | null> {
  const endpoint = contentsEndpoint(owner, repo, pluginPath);
  if (!endpoint) {
    return Promise.resolve(null);
  }
  return fetchGithubJson<PluginManifest>(
    `/${endpoint}/.claude-plugin/plugin.json`,
    "application/vnd.github.raw"
  );
}

export function fetchPluginManifest(
  owner: string,
  repo: string,
  pluginPath: string
): Promise<PluginManifest | null> {
  return restFetchPluginManifest(owner, repo, pluginPath);
}

/**
 * The outcome of a repo-stats lookup. The release is only fetched after the repo
 * call succeeds, so a missing, private, or rate-limited repo costs one request.
 *
 * ISS-10605: the status is part of the answer. A 404 is permanent — the repo is
 * absent, renamed, or private to an unauthenticated caller, and retrying cannot
 * change it — while everything else (rate limit, network, timeout) is transient
 * and the next run may well succeed. Collapsing both to `null`, as this used to,
 * left the caller unable to say which had happened, so a row that could never
 * resolve logged the same line as one that was merely throttled.
 */
export type RepoStatsResult =
  | {
      status: typeof GitHubJsonFetchStatus.Success;
      value: { repo: GitHubRepoResponse; release: string | null };
    }
  | { status: typeof GitHubJsonFetchStatus.NotFound; value: null }
  | { status: typeof GitHubJsonFetchStatus.Unavailable; value: null };

export async function fetchRepoStats(
  owner: string,
  repo: string
): Promise<RepoStatsResult> {
  const viaRest = await restFetch(owner, repo);
  if (viaRest.status !== GitHubJsonFetchStatus.Success) {
    return { status: viaRest.status, value: null };
  }
  const latestRelease = await restFetchLatestRelease(owner, repo);
  if (!latestRelease.available) {
    // A repo that simply has no releases already resolved as available above;
    // reaching here means the release call itself could not be read.
    return { status: GitHubJsonFetchStatus.Unavailable, value: null };
  }
  return {
    status: GitHubJsonFetchStatus.Success,
    value: { repo: viaRest.value, release: latestRelease.release },
  };
}

function releaseLabel(parsed: GitHubReleaseResponse): string | null {
  return parsed.tag_name || parsed.name || null;
}

/**
 * A Contents-API endpoint, `repos/<owner>/<repo>/contents/<path>`, in the
 * slash-less form (the REST caller prefixes `/`).
 *
 * `path` is catalog input — a seed `skills_path`/`plugin_path`/`skill_marker`,
 * a marketplace plugin name, or an `entry.path` read back from GitHub — so it is
 * encoded PER SEGMENT with `encodeURIComponent`: `encodeURI` on the joined path
 * leaves `#` and `?` alone, which truncate the request or inject a query. And
 * because `encodeURIComponent("..") === ".."`, encoding alone does not stop
 * `plugins/../../user` from resolving to `/repos/<owner>/user`; a segment that
 * is empty, `.` or `..` makes the whole endpoint `null`, and the caller issues
 * no request. `owner` and `repo` are already bounded by {@link parseGithubUrl}.
 */
export function contentsEndpoint(
  owner: string,
  repo: string,
  path: string
): string | null {
  const segments = path.split("/");
  if (segments.some((segment) => REFUSED_PATH_SEGMENTS.has(segment))) {
    return null;
  }
  return `repos/${owner}/${repo}/contents/${segments.map(encodeURIComponent).join("/")}`;
}

const REFUSED_PATH_SEGMENTS: ReadonlySet<string> = new Set(["", ".", ".."]);

type LatestReleaseFetchResult =
  | { available: true; release: string | null }
  | { available: false; release: null };

function githubJsonUnavailable<T = unknown>(): GitHubJsonFetchResult<T> {
  return { status: GitHubJsonFetchStatus.Unavailable, value: null };
}
