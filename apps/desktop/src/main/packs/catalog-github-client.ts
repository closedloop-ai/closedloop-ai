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
 * Auth preference is unchanged:
 *   1. Local `gh` CLI (`gh api repos/<owner>/<repo>`) — uses the user's
 *      `gh auth login`, zero credentials in the sidecar
 *   2. Unauthenticated REST (`https://api.github.com/repos/...`) — 60 req/hr;
 *      the catalog has ~10 packs / 24h so this is comfortable
 *
 * Every call is best-effort and returns null rather than throwing: a single
 * pack's 404 or rate-limit must never fail the run.
 */

import { execFile } from "node:child_process";
import https from "node:https";
import { promisify } from "node:util";

const REQUEST_TIMEOUT_MS = 5000;
const USER_AGENT = "closedloop-electron-agent-monitor";
const execFileAsync = promisify(execFile);

const GITHUB_URL_PATTERN = /github\.com[/:]([^/]+)\/([^/?#.]+)/;
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

/**
 * Parse owner/repo out of a github URL.
 *   https://github.com/owner/repo            -> { owner, repo }
 *   https://github.com/owner/repo.git        -> { owner, repo }
 *   https://github.com/owner/repo/tree/main  -> { owner, repo }
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
  return { owner: m[1], repo: m[2].replace(TRAILING_DOT_GIT, "") };
}

async function ghFetch(
  owner: string,
  repo: string
): Promise<GitHubRepoResponse | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}`,
        "--header",
        "Accept: application/vnd.github+json",
      ],
      { timeout: REQUEST_TIMEOUT_MS }
    );
    return JSON.parse(stdout) as GitHubRepoResponse;
  } catch {
    return null;
  }
}

async function ghFetchLatestRelease(
  owner: string,
  repo: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${owner}/${repo}/releases/latest`],
      { timeout: REQUEST_TIMEOUT_MS }
    );
    return releaseLabel(JSON.parse(stdout) as GitHubReleaseResponse);
  } catch {
    return null;
  }
}

function httpGetJson<T = unknown>(urlPath: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: "api.github.com",
        path: urlPath,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/vnd.github+json",
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
              resolve(JSON.parse(body) as T);
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function restFetch(
  owner: string,
  repo: string
): Promise<GitHubRepoResponse | null> {
  return httpGetJson<GitHubRepoResponse>(`/repos/${owner}/${repo}`);
}

async function restFetchLatestRelease(
  owner: string,
  repo: string
): Promise<string | null> {
  const parsed = await httpGetJson<GitHubReleaseResponse>(
    `/repos/${owner}/${repo}/releases/latest`
  );
  return parsed ? releaseLabel(parsed) : null;
}

/**
 * Fetch a marketplace sub-plugin's .claude-plugin/plugin.json from the
 * parent marketplace repo. Returns the parsed JSON or null. Used to source
 * plugin-specific description + version for catalog entries whose
 * `contents.type === 'github-claude-plugin'`.
 */
async function ghFetchPluginManifest(
  owner: string,
  repo: string,
  pluginPath: string
): Promise<PluginManifest | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/contents/${encodeURI(pluginPath)}/.claude-plugin/plugin.json`,
        "--header",
        "Accept: application/vnd.github.raw",
      ],
      { timeout: REQUEST_TIMEOUT_MS }
    );
    return JSON.parse(stdout) as PluginManifest;
  } catch {
    return null;
  }
}

function restFetchPluginManifest(
  owner: string,
  repo: string,
  pluginPath: string
): Promise<PluginManifest | null> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: "api.github.com",
        path: `/repos/${owner}/${repo}/contents/${encodeURI(pluginPath)}/.claude-plugin/plugin.json`,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/vnd.github.raw",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          res.resume();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as PluginManifest);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export function fetchPluginManifest(
  owner: string,
  repo: string,
  pluginPath: string,
  useGh: boolean
): Promise<PluginManifest | null> {
  if (useGh) {
    return ghFetchPluginManifest(owner, repo, pluginPath).then(
      (manifest) => manifest ?? restFetchPluginManifest(owner, repo, pluginPath)
    );
  }
  return restFetchPluginManifest(owner, repo, pluginPath);
}

/**
 * Repo stats + latest release, `gh` first and REST as the fallback.
 *
 * Ordering is load-bearing and unchanged from the pre-split code: with `gh`
 * available the release is only fetched when the repo call SUCCEEDED, and a
 * failed `gh` repo call re-fetches BOTH over REST. Returns null when neither
 * transport produced repo stats.
 */
export async function fetchRepoStats(
  owner: string,
  repo: string,
  useGh: boolean
): Promise<{ repo: GitHubRepoResponse; release: string | null } | null> {
  if (useGh) {
    const viaGh = await ghFetch(owner, repo);
    if (viaGh) {
      return { repo: viaGh, release: await ghFetchLatestRelease(owner, repo) };
    }
  }
  const viaRest = await restFetch(owner, repo);
  if (!viaRest) {
    return null;
  }
  return { repo: viaRest, release: await restFetchLatestRelease(owner, repo) };
}

function releaseLabel(parsed: GitHubReleaseResponse): string | null {
  return parsed.tag_name || parsed.name || null;
}
