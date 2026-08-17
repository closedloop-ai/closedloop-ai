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
import {
  type MemberTargetsInstall,
  memberInstallCellKey,
} from "@repo/app/packs/components/member-targets-block";
import { PacksWorkspace } from "@repo/app/packs/components/packs-workspace";
import { PacksWorkspaceSkeleton } from "@repo/app/packs/components/packs-workspace-skeleton";
import { deriveContentInstallStates } from "@repo/app/packs/lib/content-install-state";
import { MemberInstallDispatchTone } from "@repo/app/packs/lib/member-install-dispatch-copy";
import { LOCAL_MACHINE_TARGET_ID } from "@repo/app/packs/lib/member-targets";
import { PackContentKind, type PackView } from "@repo/app/packs/lib/pack-view";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CatalogContentItem,
  CatalogEntry,
  InstalledPackDetail,
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
  const context = useMemo(
    () =>
      createPacksContext(PacksMode.DesktopTeam, {
        // No org-wide activity feed on desktop; team-usage + performance come
        // from the per-pack analytics fetched on select.
        showActivity: false,
      }),
    []
  );

  const { packViews, entriesById, installedById, state, reload } =
    useCatalogData();
  const [pending, setPending] = useState<InstallPending | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ISS-5125: which harness the last INSTALL was attempted for. `pending` is
  // cleared in the mutation's `finally`, so without this the surviving `error`
  // has no cell to attach to and the per-machine block would either drop the
  // failure or, worse, pin it to an arbitrary harness row.
  // Also records that the last mutation WAS an install: `error` is shared by
  // install/update/uninstall, so without this an "Could not uninstall plugin."
  // would render as an install outcome pinned to whichever harness was last
  // installed. Cleared on pack selection so a failure never leaks onto another
  // pack's rows.
  const [lastInstallHarness, setLastInstallHarness] = useState<Harness | null>(
    null
  );
  const [historyKey, setHistoryKey] = useState(0);
  const runs = useRunHistory(historyKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contentsById, setContentsById] = useState<
    Map<string, CatalogContentItem[]>
  >(new Map());
  const [analyticsById, setAnalyticsById] = useState<
    Map<string, PackAnalyticsResponse>
  >(new Map());
  // Per-component install truth for THIS machine (FEA-4071). `getPackDetail`
  // returns the installed skills/components the machine actually reports on
  // disk; the detail pack derives each Contents-tab component's install state
  // from these names. A pack that isn't installed has no detail row, mapped to
  // `null` so every component reads honestly "not installed" here.
  const [detailById, setDetailById] = useState<
    Map<string, InstalledPackDetail | null>
  >(new Map());

  // Fetch (and cache) the machine's per-component install truth for a pack.
  // Used on select and again after a mutation, so the Contents tab reflects the
  // freshly installed/uninstalled component set rather than a stale snapshot.
  const fetchPackDetail = useCallback((packId: string) => {
    window.desktopApi?.db
      ?.getPackDetail?.(packId)
      ?.then((detail) => {
        setDetailById((prev) => new Map(prev).set(packId, detail));
      })
      ?.catch(() => {
        // Per-component state is best-effort; contents still render.
      });
  }, []);

  const runMutation = useCallback(
    async (packId: string, harness: Harness, action: MutationAction) => {
      const api = window.desktopApi?.db;
      if (!api) {
        return;
      }
      setPending({ harness, action });
      setError(null);
      // Set on install, CLEARED on update/uninstall — so it always answers "was
      // the last mutation an install, and on which harness?". Leaving a stale
      // harness here is what would let a failed uninstall render as an install
      // outcome on the row of some earlier install.
      setLastInstallHarness(action === "install" ? harness : null);
      try {
        // Update is an idempotent re-install of the vetted install command.
        const result =
          action === "uninstall"
            ? await api.catalogUninstall(packId, harness)
            : await api.catalogInstall(packId, harness);
        // A REJECTED promise is not the only way this fails. The vetted catalog
        // IPC RESOLVES `{ started: false, error }` for an ordinary preflight
        // refusal — no install command for the harness, an unsupported target —
        // and only throws for a broken bridge. Reading just the `catch` treated
        // every one of those refusals as a started install: the spinner cleared,
        // no error was set, and the member-install cell (ISS-5125) showed
        // neither a failure nor a Retry, so the member was left believing an
        // install ran that never began. `AgentDetailView` already reads
        // `started` for exactly this reason; this panel now agrees with it.
        if (result && !result.started) {
          setError(result.error?.message ?? `Could not ${action} plugin.`);
        }
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : `Could not ${action} plugin.`
        );
      } finally {
        setPending(null);
        setHistoryKey((k) => k + 1);
        reload();
        // The mutation changed which of the pack's components are on disk, so
        // this pack's cached per-component install truth (`detailById`) is now
        // stale. Refetch it in place so an open Contents tab reflects the new
        // Installed / Not-installed states instead of the pre-mutation snapshot
        // until the panel remounts (Codex P1). `fetchPackDetail` overwrites the
        // cache entry, so a later re-select also sees the refreshed detail. The
        // bundled contents list itself is unchanged by an install/uninstall, so
        // `contentsById` is intentionally left as-is (no flicker).
        fetchPackDetail(packId);
      }
    },
    [reload, fetchPackDetail]
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

  // ISS-5125: the member per-machine block's ACT half on DESKTOP. The block's
  // desktop cells are the synthetic local machine (`LOCAL_MACHINE_TARGET_ID`),
  // so the dispatch is this panel's existing vetted local catalog install — not
  // the cloud member-install route, which addresses a REMOTE registered node
  // this surface has no id for. Same shared flag key as web
  // (`member-self-service-install`), read through the desktop feature-flag port,
  // so the affordance cannot appear on one surface while hidden on the other.
  const memberInstallEnabled = useFeatureFlagEnabledOptional(
    MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY
  );

  const memberTargetsInstall = useMemo<MemberTargetsInstall | null>(() => {
    if (!memberInstallEnabled) {
      return null;
    }
    return {
      // `runMutation` owns its own error handling (it sets `error` in a catch
      // and always clears `pending` in a finally), so its promise is returned
      // rather than awaited — the block's feedback comes from that state, not
      // from this call site. Same shape as the header install control below.
      onInstall: ({ harness }) =>
        selectedId
          ? runMutation(selectedId, harness as Harness, "install")
          : undefined,
      // Only an INSTALL owns a cell's pending state. An update/uninstall driven
      // from the detail header is a different action on the same pack, and
      // showing its spinner on this block's Install button would claim an
      // install that is not running. At most one local mutation runs at a time
      // here, so this set holds 0 or 1 key.
      pendingCellKeys:
        pending?.action === "install"
          ? [memberInstallCellKey(LOCAL_MACHINE_TARGET_ID, pending.harness)]
          : [],
      // The local install path reports a message, not a wire dispatch state, so
      // the outcome is built directly rather than mapped through a
      // `MemberPackInstallDispatchState` this surface never receives. A local
      // failure is provably terminal — nothing was queued anywhere — so it is
      // retryable, unlike the cloud path's ambiguous `Pending`.
      dispatchByCellKey:
        error && pending === null && lastInstallHarness
          ? {
              [memberInstallCellKey(
                LOCAL_MACHINE_TARGET_ID,
                lastInstallHarness
              )]: {
                message: error,
                tone: MemberInstallDispatchTone.Danger,
                retryable: true,
              },
            }
          : undefined,
    };
  }, [
    memberInstallEnabled,
    selectedId,
    runMutation,
    pending,
    error,
    lastInstallHarness,
  ]);

  const handleSelect = useCallback(
    (packId: string | null) => {
      setSelectedId(packId);
      // The per-machine block's outcome is keyed by (machine × harness) only,
      // and the local machine row is the same row for every pack — so a failure
      // left over from the previous pack would render against the newly
      // selected one. Clear it with the selection that made it stale.
      setError(null);
      setLastInstallHarness(null);
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
      // Per-component install state for this machine (FEA-4071): the installed
      // component/skill set for the pack, so the Contents tab can mark each
      // component installed / not installed on this machine. Best-effort — an
      // error or missing detail leaves the contents without a per-component
      // indicator (honest absence, never a fabricated "not installed").
      if (!detailById.has(packId)) {
        fetchPackDetail(packId);
      }
    },
    [contentsById, analyticsById, detailById, fetchPackDetail]
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
    const withContentStates = applyContentInstallStates(
      base,
      selectedId,
      detailById
    );
    const analytics = analyticsById.get(selectedId);
    if (!analytics) {
      return withContentStates;
    }
    const { performance, teamUsage } = packAnalyticsToBlocks(analytics);
    return { ...withContentStates, performance, teamUsage };
  }, [
    selectedId,
    entriesById,
    installedById,
    contentsById,
    analyticsById,
    detailById,
  ]);

  if (state === "loading" || state === "idle") {
    // Same wrapper as the ready branch below so the skeleton sits where the
    // loaded workspace does; the skeleton ships its own testid.
    return (
      <div className="min-h-0 flex-1">
        <PacksWorkspaceSkeleton />
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
        memberTargetsDescription="Whether this pack is installed on this machine, per harness."
        memberTargetsInstall={memberTargetsInstall}
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

/**
 * Overlay per-component install state (FEA-4071) onto a detail `PackView`'s
 * Contents from this machine's installed-component truth.
 *
 * The machine's truth is `getPackDetail(packId)`: its `skills[]` are the
 * components actually installed on disk for the pack (by name). The map value
 * distinguishes three cases so the derivation stays honest:
 *  - `undefined` (key absent) — the detail read hasn't resolved yet → UNKNOWN,
 *    so contents render with no per-component indicator rather than a premature
 *    "not installed".
 *  - `null` — the read resolved but the pack has no installed detail row (not
 *    installed on this machine) → KNOWN, `packInstalled: false`, so every
 *    component reads an explicit "not installed".
 *  - a detail — KNOWN, its `skills[].name` are the installed component set.
 *
 * `getPackDetail` only enumerates installed SKILLS (`skills[]`), so the installed
 * set can only speak to skill-kind entries. We scope the derivation to
 * `PackContentKind.Skill` via `resolvableKinds`; a pack's `command`/`agent`/etc.
 * entries stay UNKNOWN (no per-component indicator) rather than being derived from
 * — and mislabelled against — an inventory that never listed them.
 */
function applyContentInstallStates(
  pack: PackView,
  packId: string,
  detailById: Map<string, InstalledPackDetail | null>
): PackView {
  if (!detailById.has(packId)) {
    return pack;
  }
  const detail = detailById.get(packId) ?? null;
  const contents = deriveContentInstallStates(pack.contents, {
    known: true,
    installedComponentNames: (detail?.skills ?? [])
      .map((skill) => skill.name)
      .filter((name): name is string => Boolean(name)),
    packInstalled: detail !== null,
    resolvableKinds: [PackContentKind.Skill],
  });
  return { ...pack, contents };
}
