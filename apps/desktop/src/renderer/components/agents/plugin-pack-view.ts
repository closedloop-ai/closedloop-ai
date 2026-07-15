/**
 * Maps the desktop pack IPC rows (`CatalogEntry` + installed state) onto the
 * shared `PackView` view-model the unified Packs UX renders. Keeps the renderer
 * the single place that knows about `window.desktopApi` shapes; the shared
 * components stay surface-agnostic.
 */

import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import type { Harness } from "@repo/app/agents/lib/session-types";
import {
  type PackContentEntry,
  type PackPerformance,
  type PackTeamUsage,
  type PackView,
  toPackContentKind,
} from "@repo/app/packs/lib/pack-view";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import type {
  CatalogContentItem,
  CatalogEntry,
  InstalledPack,
} from "../../../shared/agent-db-contract";

/**
 * Map the cloud per-pack analytics (`PackAnalyticsResponse`) onto the shared
 * `PackView` team-usage + performance blocks for the desktop-team overlay.
 */
export function packAnalyticsToBlocks(analytics: PackAnalyticsResponse): {
  performance: PackPerformance;
  teamUsage: PackTeamUsage;
} {
  const installers = analytics.owners.map((name) => ({
    id: name,
    name,
    initials: getInitials(name),
  }));
  return {
    performance: {
      klocPerDollar: analytics.klocPerDollar,
      invocations: analytics.invocations,
      sessions: analytics.sessions,
      usageTrend: [],
    },
    teamUsage: {
      installers,
      installedCount: installers.length,
      deviceCount: analytics.deviceCount,
      installTrend: [],
    },
  };
}

const GITHUB_OWNER_RE = /github\.com\/([^/]+)/i;

/** Best-effort publisher from a GitHub repo URL (the owner segment). */
function publisherFromGithub(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const match = url.match(GITHUB_OWNER_RE);
  return match ? match[1] : null;
}

function contentsToEntries(
  items: CatalogContentItem[] | null | undefined
): PackContentEntry[] {
  if (!items) {
    return [];
  }
  return items.map((item) => ({
    name: item.name,
    kind: toPackContentKind(item.type),
    description: item.description ?? null,
  }));
}

/**
 * Build a `PackView` from a catalog entry and the authoritative installed
 * harnesses (merged from `getInstalledPacks`). Optionally overrides the bundled
 * contents with a freshly-fetched `getCatalogContents` result for the detail view.
 */
export function catalogEntryToPackView(
  entry: CatalogEntry,
  installedHarnesses: string[],
  contentsOverride?: CatalogContentItem[] | null
): PackView {
  const contents = contentsOverride
    ? contentsToEntries(contentsOverride)
    : contentsToEntries(entry.contentsCache);

  return {
    id: entry.packId,
    name: entry.displayName,
    publisher: publisherFromGithub(entry.githubUrl),
    category: entry.category,
    description: entry.descriptionLive ?? entry.description,
    githubUrl: entry.githubUrl,
    marketplaceUrl: entry.marketplaceUrl,
    stars: entry.stars,
    starHistory: entry.history.map((point) => point.stars),
    verified: entry.verified,
    harnesses: entry.harnesses as Harness[],
    installedHarnesses: installedHarnesses as Harness[],
    installedByMe: installedHarnesses.length > 0,
    installNotes: entry.installNotes,
    placeholderReason: entry.placeholderReason,
    usageCount: entry.usageCount,
    contents,
    teamUsage: null,
    activity: null,
    performance: null,
    distribution: null,
  };
}

/**
 * Merge catalog entries against a pre-built `packId → installed harnesses` map
 * into `PackView`s. This is the single source of truth for the catalog+installed
 * merge: `plugins-panel` (which already keeps the installed map in component
 * state) calls this directly, and {@link buildPackViews} calls it after building
 * the map from raw `InstalledPack[]` rows. Falls back to each entry's own
 * `installedHarnesses` when the map has no row for that pack.
 */
export function buildPackViewsFromInstalledMap(
  catalog: CatalogEntry[],
  installedByPackId: Map<string, string[]>
): PackView[] {
  return catalog.map((entry) =>
    catalogEntryToPackView(
      entry,
      installedByPackId.get(entry.packId) ?? entry.installedHarnesses ?? []
    )
  );
}

/** Merge catalog + installed rows into `PackView`s (mirrors plugins-panel merge). */
export function buildPackViews(
  catalog: CatalogEntry[],
  installed: InstalledPack[]
): PackView[] {
  const installedByPack = new Map<string, string[]>();
  for (const pack of installed) {
    installedByPack.set(pack.packId, pack.harnesses);
  }
  return buildPackViewsFromInstalledMap(catalog, installedByPack);
}
