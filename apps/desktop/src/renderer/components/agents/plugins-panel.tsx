/**
 * Desktop Plugins management panel (FEA-2923 / T-16.4; unified Packs UX).
 *
 * Hosts the shared, prototype-styled `PacksWorkspace` (discovery grid + detail
 * with Contents/… tabs) inside the Agents workspace, backed by the preserved
 * main-process pack IPC on `window.desktopApi.db`:
 *
 *   - `getCatalog()`         — browse available plugins (org/curated store)
 *   - `getInstalledPacks()`  — installed harnesses for update/uninstall state
 *   - `getCatalogContents()` — bundled contents for the detail Contents tab
 *   - `catalogInstall()`     — install a plugin for a harness
 *   - `catalogUninstall()`   — uninstall a plugin for a harness
 *   - `getInstallRuns()`     — recent install/uninstall run history
 *   - `onInstallOutput()`    — streamed run output (drives a live refresh)
 *
 * "Update" is a re-install of an already-installed pack (the catalog-install
 * path is idempotent). All mutations route through the same `desktopApi.db.catalog*`
 * channels the prior panel used — no functionality lost, only re-skinned onto the
 * shared UX. Desktop-team context: on pack-select, per-pack org-wide analytics
 * (`getPackAnalytics`, main → cloud) overlay the Team-usage + Performance tabs.
 */

import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import type { Harness } from "@repo/app/agents/lib/session-types";
import type { InstallPending } from "@repo/app/packs/components/install-controls";
import { PacksWorkspace } from "@repo/app/packs/components/packs-workspace";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CatalogContentItem,
  CatalogEntry,
  InstallRunRecord,
} from "../../../shared/agent-db-contract";
import {
  buildPackViewsFromInstalledMap,
  catalogEntryToPackView,
  packAnalyticsToBlocks,
} from "./plugin-pack-view";

/** Default harness used for install/uninstall when a pack lists none. */
const DEFAULT_HARNESS = "claude";

type LoadState = "idle" | "loading" | "ready" | "error";
type MutationAction = "install" | "uninstall" | "update";

type CatalogData = {
  packViews: PackView[];
  entriesById: Map<string, CatalogEntry>;
  installedById: Map<string, string[]>;
  state: LoadState;
  reload: () => void;
};

/** Loads catalog + installed-pack state and derives `PackView`s + lookup maps. */
function useCatalogData(): CatalogData {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [installedById, setInstalledById] = useState<Map<string, string[]>>(
    new Map()
  );
  const [state, setState] = useState<LoadState>("idle");

  const reload = useCallback(() => {
    const api = window.desktopApi?.db;
    if (!api) {
      setState("error");
      return;
    }
    setState("loading");
    Promise.all([api.getCatalog(), api.getInstalledPacks()])
      .then(([catalog, installed]) => {
        setEntries(catalog);
        const map = new Map<string, string[]>();
        for (const pack of installed) {
          map.set(pack.packId, pack.harnesses);
        }
        setInstalledById(map);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(() => {
    reload();
    // Refresh whenever an install/uninstall run completes.
    const unsubscribe = window.desktopApi?.onInstallOutput?.((chunk) => {
      if (chunk.type === "complete") {
        reload();
      }
    });
    return () => unsubscribe?.();
  }, [reload]);

  const entriesById = useMemo(() => {
    const map = new Map<string, CatalogEntry>();
    for (const entry of entries) {
      map.set(entry.packId, entry);
    }
    return map;
  }, [entries]);

  const packViews = useMemo(
    () => buildPackViewsFromInstalledMap(entries, installedById),
    [entries, installedById]
  );

  return { packViews, entriesById, installedById, state, reload };
}

function useRunHistory(refreshKey: number): InstallRunRecord[] {
  const [runs, setRuns] = useState<InstallRunRecord[]>([]);
  // `refreshKey` is an intentional re-fetch trigger (bumped after each mutation).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional refetch key
  useEffect(() => {
    let cancelled = false;
    window.desktopApi?.db
      ?.getInstallRuns()
      .then((records) => {
        if (!cancelled) {
          setRuns(records);
        }
      })
      .catch(() => {
        // Run history is best-effort; leave it empty on error.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return runs;
}

export function PluginsPanel() {
  const showExtended = useFeatureFlagEnabled(
    PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY
  );
  const context = useMemo(
    () =>
      createPacksContext(PacksMode.DesktopTeam, {
        showExtendedContentKinds: showExtended,
        // No org-wide activity feed on desktop; team-usage + performance come
        // from the per-pack analytics fetched on select.
        showActivity: false,
      }),
    [showExtended]
  );

  const { packViews, entriesById, installedById, state, reload } =
    useCatalogData();
  const [pending, setPending] = useState<InstallPending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const runs = useRunHistory(historyKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contentsById, setContentsById] = useState<
    Map<string, CatalogContentItem[]>
  >(new Map());
  const [analyticsById, setAnalyticsById] = useState<
    Map<string, PackAnalyticsResponse>
  >(new Map());

  const runMutation = useCallback(
    async (packId: string, harness: Harness, action: MutationAction) => {
      const api = window.desktopApi?.db;
      if (!api) {
        return;
      }
      setPending({ harness, action });
      setError(null);
      try {
        // Update is an idempotent re-install of the vetted install command.
        if (action === "uninstall") {
          await api.catalogUninstall(packId, harness);
        } else {
          await api.catalogInstall(packId, harness);
        }
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : `Could not ${action} plugin.`
        );
      } finally {
        setPending(null);
        setHistoryKey((k) => k + 1);
        reload();
      }
    },
    [reload]
  );

  const resolveHarness = useCallback(
    (packId: string, harness?: Harness): Harness => {
      if (harness) {
        return harness;
      }
      const entry = entriesById.get(packId);
      return (entry?.harnesses[0] as Harness) ?? DEFAULT_HARNESS;
    },
    [entriesById]
  );

  const handleSelect = useCallback(
    (packId: string | null) => {
      setSelectedId(packId);
      if (!packId) {
        return;
      }
      if (!contentsById.has(packId)) {
        window.desktopApi?.db
          ?.getCatalogContents?.(packId)
          ?.then((contents) => {
            if (contents) {
              setContentsById((prev) =>
                new Map(prev).set(packId, contents as CatalogContentItem[])
              );
            }
          })
          ?.catch(() => {
            // Contents are best-effort; the cached entry contents still render.
          });
      }
      // Org-wide team-usage + performance overlay (best-effort; requires
      // sign-in + cloud reach — null when unavailable, tabs stay hidden).
      if (!analyticsById.has(packId)) {
        window.desktopApi?.db
          ?.getPackAnalytics?.(packId)
          ?.then((analytics) => {
            if (analytics) {
              setAnalyticsById((prev) => new Map(prev).set(packId, analytics));
            }
          })
          ?.catch(() => {
            // Overlay is best-effort; the pack still renders without it.
          });
      }
    },
    [contentsById, analyticsById]
  );

  const detailPack = useMemo<PackView | null>(() => {
    if (!selectedId) {
      return null;
    }
    const entry = entriesById.get(selectedId);
    if (!entry) {
      return null;
    }
    const installed =
      installedById.get(selectedId) ?? entry.installedHarnesses ?? [];
    const base = catalogEntryToPackView(
      entry,
      installed,
      contentsById.get(selectedId) ?? null
    );
    const analytics = analyticsById.get(selectedId);
    if (!analytics) {
      return base;
    }
    const { performance, teamUsage } = packAnalyticsToBlocks(analytics);
    return { ...base, performance, teamUsage };
  }, [selectedId, entriesById, installedById, contentsById, analyticsById]);

  if (state === "loading" || state === "idle") {
    return (
      <div className="flex flex-col gap-2 p-4" data-testid="plugins-loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        className="p-4 text-muted-foreground text-sm"
        data-testid="plugins-error"
      >
        Could not load the plugin catalog.{" "}
        <button className="underline" onClick={reload} type="button">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1" data-testid="plugins-panel">
      <PacksWorkspace
        context={context}
        detailPack={detailPack}
        footerSlot={<RunHistoryList runs={runs} />}
        installError={error}
        installPending={pending}
        onInstall={(packId, harness) =>
          runMutation(packId, resolveHarness(packId, harness), "install")
        }
        onSelectPack={handleSelect}
        onUninstall={(packId, harness) =>
          runMutation(packId, harness, "uninstall")
        }
        onUpdate={(packId, harness) => runMutation(packId, harness, "update")}
        packs={packViews}
      />
    </div>
  );
}

function RunHistoryList({ runs }: { runs: InstallRunRecord[] }) {
  const sorted = useMemo(() => runs.slice(0, 20), [runs]);
  return (
    <section className="px-6 pb-6">
      <h2 className="mb-2 font-semibold text-sm">Run history</h2>
      {sorted.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="run-history-empty"
        >
          No install runs recorded yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="run-history-list">
          {sorted.map((run) => (
            <li
              className="flex items-center justify-between rounded border border-border px-3 py-1.5 text-xs"
              key={run.id}
            >
              <span className="truncate">
                {run.action} · {run.packId}
                {run.harness ? ` (${run.harness})` : ""}
              </span>
              <RunStatusBadge exitCode={run.exitCode} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunStatusBadge({ exitCode }: { exitCode: number | null }) {
  if (exitCode === null) {
    return <Badge variant="secondary">Running</Badge>;
  }
  if (exitCode === 0) {
    return <Badge variant="secondary">Success</Badge>;
  }
  return <Badge variant="destructive">Failed ({exitCode})</Badge>;
}
