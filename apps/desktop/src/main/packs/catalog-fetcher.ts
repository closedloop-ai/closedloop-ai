/**
 * @file catalog-fetcher.ts
 * @description Periodic GitHub stats fetcher for the Agent Pack Catalog
 * (FEA-1314 / PLN-657). Walks every row in `pack_catalog`, hits the GitHub
 * REST API for stars/forks/description/latest-release, and writes the
 * result via catalog-store.applyFetchResult — which both updates live
 * fields on pack_catalog and appends a row to pack_catalog_history (for the
 * sparkline).
 *
 * Auth preference:
 *   1. Local `gh` CLI (`gh api repos/<owner>/<repo>`) — uses the user's
 *      `gh auth login`, zero credentials in the sidecar
 *   2. Unauthenticated REST (`https://api.github.com/repos/...`) — 60
 *      req/hr; the catalog has ~10 packs / 24h so this is comfortable
 *
 * Best-effort: a single pack's 404/rate-limit logs a warning and continues;
 * the run as a whole always returns a summary.
 */

import { execFile } from "node:child_process";
import https from "node:https";
import { promisify } from "node:util";
import { resolveBinaryFromLoginShellSync } from "../../server/shell-path.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../gateway-logger.js";
import { applyFetchResult } from "./catalog-store.js";

// FEA-1314 v6: marketplace sub-plugins (e.g. code-review, context7) live as
// folders inside a parent marketplace repo. The default per-repo fetch
// (stars + description) writes the MARKETPLACE's stars/description to every
// sub-plugin row, making all of them look identical (e.g. 5 plugins all
// showing "21.3k stars · Official, Anthropic-managed directory of...").
// For these, we instead fetch each plugin's own .claude-plugin/plugin.json
// for its plugin-specific name/description/version, and leave stars NULL —
// the marketplace's star count doesn't represent the individual plugin.

const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const USER_AGENT = "closedloop-electron-agent-monitor";
const execFileAsync = promisify(execFile);

type ParsedRepo = {
  owner: string;
  repo: string;
};

type FetchSummary = {
  started_at: string;
  ended_at?: string;
  used_gh_cli: boolean;
  succeeded: number;
  failed: number;
  skipped: number;
};

type ContentsJson = {
  type?: string;
  marketplace_repo?: string;
  plugin_path?: string;
};

type GitHubRepoResponse = {
  stargazers_count?: number;
  forks_count?: number;
  description?: string;
};

type GitHubReleaseResponse = {
  tag_name?: string;
  name?: string;
};

type PluginManifest = {
  description?: string;
  version?: string;
};

export function ghCliAvailable(): boolean {
  const result = resolveBinaryFromLoginShellSync("gh");
  return result.source !== "fallback" && result.source !== "override_invalid";
}

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
  const m = url.match(/github\.com[/:]([^/]+)\/([^/?#.]+)/);
  if (!m) {
    return null;
  }
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
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
    const parsed = JSON.parse(stdout) as GitHubReleaseResponse;
    return parsed && (parsed.tag_name || parsed.name)
      ? (parsed.tag_name || parsed.name)!
      : null;
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

async function restFetch(
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
  return parsed && (parsed.tag_name || parsed.name)
    ? (parsed.tag_name || parsed.name)!
    : null;
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
        res.on("data", (c: string) => (body += c));
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

async function fetchPluginManifest(
  owner: string,
  repo: string,
  pluginPath: string,
  useGh: boolean
): Promise<PluginManifest | null> {
  if (useGh) {
    const m = await ghFetchPluginManifest(owner, repo, pluginPath);
    if (m) {
      return m;
    }
  }
  return restFetchPluginManifest(owner, repo, pluginPath);
}

function parseJsonField(value: unknown): ContentsJson | null {
  if (!value) {
    return null;
  }
  // The `contents` Json column may come back already parsed (an object) or as a
  // JSON-encoded TEXT string. Handle both so the marketplace-sub-plugin detection
  // is robust to either shape.
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as ContentsJson;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ContentsJson;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fetch stats for every pack in pack_catalog and apply them via the store.
 * Best-effort per pack; returns a summary.
 */
export async function runCatalogFetch(
  prisma: DesktopPrisma
): Promise<FetchSummary> {
  const summary: FetchSummary = {
    started_at: new Date().toISOString(),
    used_gh_cli: ghCliAvailable(),
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  let rows: { packId: string; githubUrl: string; contents: unknown }[];
  try {
    rows = await prisma.client.packCatalog.findMany({
      select: { packId: true, githubUrl: true, contents: true },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("catalog-fetcher", `cannot read pack_catalog: ${msg}`);
    return summary;
  }

  for (const row of rows) {
    const parsed = parseGithubUrl(row.githubUrl);
    if (!parsed) {
      summary.skipped += 1;
      continue;
    }

    const contents = parseJsonField(row.contents);
    const isMarketplaceSubPlugin =
      contents && contents.type === "github-claude-plugin";

    if (isMarketplaceSubPlugin) {
      // FEA-1314 v7: marketplace sub-plugin path. Always fetch the manifest
      // from contents.marketplace_repo (where the install lives). For
      // stars/forks: if `github_url` parses to the SAME repo as
      // contents.marketplace_repo, then github_url is a subdirectory of the
      // marketplace and has no independent star count — leave stars null
      // (avoids the v5 "all 4 cards show 21.3k" bug). If github_url is a
      // DIFFERENT repo (e.g. context7's github_url=upstash/context7,
      // marketplace_repo=anthropics/claude-plugins-official), that's a true
      // upstream and we fetch its real star count.
      const mkRepo = contents.marketplace_repo
        ? parseGithubUrl(`https://github.com/${contents.marketplace_repo}`)
        : null;
      const manifestOwner = mkRepo ? mkRepo.owner : parsed.owner;
      const manifestRepo = mkRepo ? mkRepo.repo : parsed.repo;
      const manifest = await fetchPluginManifest(
        manifestOwner,
        manifestRepo,
        contents.plugin_path!,
        summary.used_gh_cli
      );
      if (!manifest) {
        summary.failed += 1;
        continue;
      }

      // Decide if github_url points to a distinct upstream.
      const sameAsMarketplace =
        mkRepo && parsed.owner === mkRepo.owner && parsed.repo === mkRepo.repo;
      let stars: number | null = null;
      let forks: number | null = null;
      let release: string | null = null;
      if (!sameAsMarketplace) {
        let repo: GitHubRepoResponse | null = summary.used_gh_cli
          ? await ghFetch(parsed.owner, parsed.repo)
          : null;
        if (!repo) {
          repo = await restFetch(parsed.owner, parsed.repo);
        }
        if (repo) {
          stars = repo.stargazers_count == null ? null : repo.stargazers_count;
          forks = repo.forks_count == null ? null : repo.forks_count;
          release = summary.used_gh_cli
            ? await ghFetchLatestRelease(parsed.owner, parsed.repo)
            : await restFetchLatestRelease(parsed.owner, parsed.repo);
        }
      }

      try {
        await applyFetchResult(prisma, {
          pack_id: row.packId,
          stars,
          forks,
          description: manifest.description || null,
          last_release: manifest.version || release || null,
        });
        summary.succeeded += 1;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        gatewayLog.warn(
          "catalog-fetcher",
          `applyFetchResult failed for ${row.packId}: ${msg}`
        );
        summary.failed += 1;
      }
      continue;
    }

    // Default path: standalone repo — fetch its stars + description.
    let repo: GitHubRepoResponse | null = null;
    let release: string | null = null;
    if (summary.used_gh_cli) {
      repo = await ghFetch(parsed.owner, parsed.repo);
      if (repo) {
        release = await ghFetchLatestRelease(parsed.owner, parsed.repo);
      }
    }
    if (!repo) {
      repo = await restFetch(parsed.owner, parsed.repo);
      if (repo) {
        release = await restFetchLatestRelease(parsed.owner, parsed.repo);
      }
    }
    if (!repo) {
      summary.failed += 1;
      continue;
    }
    try {
      await applyFetchResult(prisma, {
        pack_id: row.packId,
        stars: repo.stargazers_count == null ? null : repo.stargazers_count,
        forks: repo.forks_count == null ? null : repo.forks_count,
        description: repo.description || null,
        last_release: release,
      });
      summary.succeeded += 1;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "catalog-fetcher",
        `applyFetchResult failed for ${row.packId}: ${msg}`
      );
      summary.failed += 1;
    }
  }

  summary.ended_at = new Date().toISOString();
  return summary;
}

/**
 * Schedule recurring fetches. Returns a handle that can be cleared. Called by
 * startup code; the immediate run happens separately. Takes a `run` thunk rather
 * than a `DesktopPrisma` because `runCatalogFetch`'s `prisma.write` can't cross
 * the FEA-2038 DB-host proxy — callers pass `() => invokeStoreOp("catalog.fetch.run")`
 * so the fetch executes in the DB host child (see db-host-worker.ts storeOps).
 */
export function scheduleCatalogFetch(
  run: () => Promise<unknown>,
  intervalMs: number = DEFAULT_INTERVAL_MS
): ReturnType<typeof setInterval> {
  const handle = setInterval(() => {
    run().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn("catalog-fetcher", `scheduled run failed: ${msg}`);
    });
  }, intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }
  return handle;
}
