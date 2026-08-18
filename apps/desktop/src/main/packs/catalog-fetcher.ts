/**
 * @file catalog-fetcher.ts
 * @description Periodic GitHub stats fetcher for the Agent Pack Catalog
 * (FEA-1314 / PLN-657). Walks every row in `pack_catalog`, hits the GitHub
 * REST API for stars/forks/description/latest-release, and writes the
 * result via catalog-store.applyFetchResult — which both updates live
 * fields on pack_catalog and appends a row to pack_catalog_history (for the
 * sparkline).
 *
 * ISS-5274 SPLIT. The run is two halves that execute in DIFFERENT processes:
 *
 *   - {@link collectCatalogFetchPlan} — network only, no DB. Runs in the MAIN
 *     process, where ~20 `gh`/HTTPS calls can take their time without occupying
 *     the db-host's op queue. This is the expensive half: it was measured at
 *     13.4s of `store:catalog.fetch.run` on a real machine, two orders of
 *     magnitude over the 100ms db-op budget.
 *   - {@link applyCatalogFetchPlan} — DB only, no network. Runs in the db-host,
 *     the sole SQLite writer.
 *
 * {@link runCatalogFetch} composes the same two halves in-process and remains
 * the unchanged fallback store op, so a machine where the coordinator can't run
 * still gets a completed fetch. Composing rather than duplicating the loop is
 * deliberate: a second copy of the per-row policy would be free to drift, and
 * the drift would be invisible because the fallback only runs when the split
 * path already failed.
 *
 * The GitHub transport itself lives in `./catalog-github-client.js`.
 *
 * Best-effort: a single pack's 404/rate-limit logs a warning and continues;
 * the run as a whole always returns a summary.
 */

import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import { resolveBinaryFromLoginShellSync } from "../../server/shell-path.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  fetchPluginManifest,
  fetchRepoStats,
  parseGithubUrl,
} from "./catalog-github-client.js";
import { applyFetchResult } from "./catalog-store.js";
import { sha256Hex } from "./definition-variant-fold.js";

// FEA-1314 v6: marketplace sub-plugins (e.g. code-review, context7) live as
// folders inside a parent marketplace repo. The default per-repo fetch
// (stars + description) writes the MARKETPLACE's stars/description to every
// sub-plugin row, making all of them look identical (e.g. 5 plugins all
// showing "21.3k stars · Official, Anthropic-managed directory of...").
// For these, we instead fetch each plugin's own .claude-plugin/plugin.json
// for its plugin-specific name/description/version, and leave stars NULL —
// the marketplace's star count doesn't represent the individual plugin.

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export type FetchSummary = {
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

/** The `pack_catalog` columns the fetch reads — its ONE db-host read. */
export type CatalogFetchRow = {
  packId: string;
  githubUrl: string;
  contents: unknown;
};

/** One row's fetched values, ready to write. */
export type CatalogFetchPlanEntry = {
  packId: string;
  /**
   * Identity of the SOURCE this entry was fetched for. Re-checked at apply
   * time so a seed that rewrote the row mid-fetch is not overwritten with
   * stats fetched for its previous source.
   */
  sourceFingerprint: string;
  stars: number | null;
  forks: number | null;
  description: string | null;
  lastRelease: string | null;
};

export type CatalogFetchPlan = {
  startedAt: string;
  usedGhCli: boolean;
  entries: CatalogFetchPlanEntry[];
  /** Rows whose `github_url` did not parse — nothing to fetch. */
  skipped: number;
  /** Rows whose network fetch produced nothing usable. */
  failed: number;
};

/**
 * Whether the local `gh` CLI is usable, resolved SYNCHRONOUSLY through a login
 * shell.
 *
 * ISS-5274 — DO NOT call this from the main process. The sync resolver
 * (`resolveBinaryFromLoginShellSync`) spawns a login shell and measured 2,667ms
 * of `resolveExecutablesOnPathSync` in the perf baseline; on the main thread
 * that is a hard UI freeze, strictly worse than today where it only blocks the
 * db-host. It stays exported for {@link runCatalogFetch}, the in-db-host
 * fallback. Main-process callers inject the ASYNC resolver instead — see
 * `catalog-fetch-coordinator.ts`.
 */
export function ghCliAvailable(): boolean {
  const result = resolveBinaryFromLoginShellSync("gh");
  return result.source !== "fallback" && result.source !== "override_invalid";
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
 * Identity of the row's fetch SOURCE — the inputs that decide what gets
 * fetched and how the result is interpreted.
 *
 * `githubUrl` alone is insufficient: `catalog-store` rewrites `contents` and
 * `githubUrl` together as seed-owned fields, so a seed can replace `contents`
 * while `githubUrl` stays byte-identical — and `contents` is what selects the
 * marketplace-sub-plugin branch and supplies `marketplace_repo`/`plugin_path`.
 *
 * `contents` is fingerprinted through {@link parseJsonField} rather than raw, so
 * the same value read once as an object and once as a JSON string produces the
 * SAME fingerprint. Fingerprinting the raw column would make every apply look
 * stale and silently stop the catalog from ever updating.
 *
 * The NUL separator is written `\u0000` (never a raw byte) per the repo's
 * source-gate convention: a raw NUL makes the whole file read as binary to git
 * and grep.
 */
export function catalogSourceFingerprint(row: {
  githubUrl: string | null;
  contents: unknown;
}): string {
  return sha256Hex(
    `${row.githubUrl ?? ""}\u0000${stableStringify(parseJsonField(row.contents))}`
  );
}

/**
 * The GitHub calls the collect half makes. Injectable so the per-row branch
 * POLICY — which of the two paths a row takes, when stars are deliberately left
 * null, what the fallback ordering is — can be tested without a network.
 */
export type CatalogFetchTransport = {
  fetchRepoStats: typeof fetchRepoStats;
  fetchPluginManifest: typeof fetchPluginManifest;
};

const REAL_TRANSPORT: CatalogFetchTransport = {
  fetchRepoStats,
  fetchPluginManifest,
};

/**
 * Fetch stats for every catalog row. NETWORK ONLY — takes the rows and returns
 * a plan, touching no database, so it can run in the main process while the
 * db-host serves renderer reads.
 *
 * `ghAvailable` is a PARAMETER, never resolved here: the main process must
 * supply it from the async resolver (see {@link ghCliAvailable}).
 *
 * `shouldStop` is checked BETWEEN rows so app teardown does not keep launching
 * requests. This matters because of where the work now runs: while the fetch
 * lived in the db-host, closing that child process killed any in-flight
 * requests outright. In the main process nothing does that, so without this
 * check a quit during the first row would still march through every remaining
 * row — up to two 5s-timeout calls each — keeping the main process busy long
 * after the user asked it to close. A stopped collect returns what it has and
 * the caller (already stopped) never applies it.
 */
export async function collectCatalogFetchPlan(
  rows: readonly CatalogFetchRow[],
  options: {
    ghAvailable: boolean;
    transport?: CatalogFetchTransport;
    shouldStop?: () => boolean;
  }
): Promise<CatalogFetchPlan> {
  const transport = options.transport ?? REAL_TRANSPORT;
  const shouldStop = options.shouldStop ?? (() => false);
  const plan: CatalogFetchPlan = {
    startedAt: new Date().toISOString(),
    usedGhCli: options.ghAvailable,
    entries: [],
    skipped: 0,
    failed: 0,
  };
  for (const row of rows) {
    if (shouldStop()) {
      return plan;
    }
    const parsed = parseGithubUrl(row.githubUrl);
    if (!parsed) {
      plan.skipped += 1;
      continue;
    }
    const contents = parseJsonField(row.contents);
    const entry =
      contents?.type === "github-claude-plugin"
        ? await collectMarketplacePluginEntry(
            row,
            parsed,
            contents,
            plan,
            transport
          )
        : await collectRepoEntry(row, parsed, plan, transport);
    if (entry) {
      plan.entries.push(entry);
    }
  }
  return plan;
}

/**
 * Write a collected plan. DB ONLY — no network, so this is all that remains on
 * the db-host.
 *
 * An entry whose row no longer matches the fingerprint it was fetched for is
 * SKIPPED, not written: between collect and apply a seed may have re-pointed
 * the row at a different repo, and writing then would attach one source's stars
 * to another source's row. It counts as `skipped` alongside the unparseable-URL
 * rows — both mean "considered, not written" — and is logged with its packId so
 * the two are distinguishable in the log.
 */
export async function applyCatalogFetchPlan(
  prisma: DesktopPrisma,
  plan: CatalogFetchPlan
): Promise<FetchSummary> {
  const summary: FetchSummary = {
    started_at: plan.startedAt,
    used_gh_cli: plan.usedGhCli,
    succeeded: 0,
    failed: plan.failed,
    skipped: plan.skipped,
  };
  const current = await readCatalogFetchRows(prisma);
  const fingerprints = new Map(
    current.map((row) => [row.packId, catalogSourceFingerprint(row)])
  );
  for (const entry of plan.entries) {
    if (fingerprints.get(entry.packId) !== entry.sourceFingerprint) {
      summary.skipped += 1;
      gatewayLog.warn(
        "catalog-fetcher",
        `skipping ${entry.packId}: catalog source changed during fetch`
      );
      continue;
    }
    try {
      await applyFetchResult(prisma, {
        pack_id: entry.packId,
        stars: entry.stars,
        forks: entry.forks,
        description: entry.description,
        last_release: entry.lastRelease,
      });
      summary.succeeded += 1;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "catalog-fetcher",
        `applyFetchResult failed for ${entry.packId}: ${msg}`
      );
      summary.failed += 1;
    }
  }
  summary.ended_at = new Date().toISOString();
  return summary;
}

/** The fetch's single catalog read, surfaced as its own db-host store op. */
export async function readCatalogFetchRows(
  prisma: DesktopPrisma
): Promise<CatalogFetchRow[]> {
  return await prisma.client.packCatalog.findMany({
    select: { packId: true, githubUrl: true, contents: true },
  });
}

/**
 * Fetch stats for every pack in pack_catalog and apply them via the store.
 * Best-effort per pack; returns a summary.
 *
 * The in-db-host fallback: same two halves as the split path, composed here so
 * the per-row policy has exactly one implementation.
 */
export async function runCatalogFetch(
  prisma: DesktopPrisma
): Promise<FetchSummary> {
  const startedAt = new Date().toISOString();
  const ghAvailable = ghCliAvailable();
  let rows: CatalogFetchRow[];
  try {
    rows = await readCatalogFetchRows(prisma);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("catalog-fetcher", `cannot read pack_catalog: ${msg}`);
    return {
      started_at: startedAt,
      used_gh_cli: ghAvailable,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
  }
  const plan = await collectCatalogFetchPlan(rows, { ghAvailable });
  return await applyCatalogFetchPlan(prisma, plan);
}

/**
 * Schedule recurring fetches. Returns a handle that can be cleared. Called by
 * startup code; the immediate run happens separately. Takes a `run` thunk rather
 * than a `DesktopPrisma` because the fetch's `prisma.write` can't cross the
 * FEA-2038 DB-host proxy — callers pass the catalog coordinator's thunk (or,
 * without a coordinator, `() => invokeStoreOp("catalog.fetch.run")`).
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

/**
 * FEA-1314 v7: marketplace sub-plugin path. Always fetch the manifest from
 * `contents.marketplace_repo` (where the install lives). For stars/forks: if
 * `github_url` parses to the SAME repo as `contents.marketplace_repo`, then
 * github_url is a subdirectory of the marketplace and has no independent star
 * count — leave stars null (avoids the v5 "all 4 cards show 21.3k" bug). If
 * github_url is a DIFFERENT repo (e.g. context7's github_url=upstash/context7,
 * marketplace_repo=anthropics/claude-plugins-official), that's a true upstream
 * and we fetch its real star count.
 */
async function collectMarketplacePluginEntry(
  row: CatalogFetchRow,
  parsed: { owner: string; repo: string },
  contents: ContentsJson,
  plan: CatalogFetchPlan,
  transport: CatalogFetchTransport
): Promise<CatalogFetchPlanEntry | null> {
  const mkRepo = contents.marketplace_repo
    ? parseGithubUrl(`https://github.com/${contents.marketplace_repo}`)
    : null;
  const manifest = await transport.fetchPluginManifest(
    mkRepo ? mkRepo.owner : parsed.owner,
    mkRepo ? mkRepo.repo : parsed.repo,
    contents.plugin_path ?? "",
    plan.usedGhCli
  );
  if (!manifest) {
    plan.failed += 1;
    return null;
  }
  // Decide if github_url points to a distinct upstream.
  const sameAsMarketplace =
    mkRepo && parsed.owner === mkRepo.owner && parsed.repo === mkRepo.repo;
  const stats = sameAsMarketplace
    ? null
    : await transport.fetchRepoStats(parsed.owner, parsed.repo, plan.usedGhCli);
  return {
    packId: row.packId,
    sourceFingerprint: catalogSourceFingerprint(row),
    stars: stats?.repo.stargazers_count ?? null,
    forks: stats?.repo.forks_count ?? null,
    description: manifest.description || null,
    lastRelease: manifest.version || stats?.release || null,
  };
}

/** Default path: standalone repo — fetch its stars + description. */
async function collectRepoEntry(
  row: CatalogFetchRow,
  parsed: { owner: string; repo: string },
  plan: CatalogFetchPlan,
  transport: CatalogFetchTransport
): Promise<CatalogFetchPlanEntry | null> {
  const stats = await transport.fetchRepoStats(
    parsed.owner,
    parsed.repo,
    plan.usedGhCli
  );
  if (!stats) {
    plan.failed += 1;
    return null;
  }
  return {
    packId: row.packId,
    sourceFingerprint: catalogSourceFingerprint(row),
    stars: stats.repo.stargazers_count ?? null,
    forks: stats.repo.forks_count ?? null,
    description: stats.repo.description || null,
    lastRelease: stats.release,
  };
}
