"use client";

import {
  TabHistoryMode,
  useTabParam,
} from "@repo/app/shared/hooks/use-tab-param";
import type { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { usePath } from "@repo/navigation/use-path";
import { useCallback, useEffect, useRef, useState } from "react";

/** A type's visible tabs and URL aliases, supplied by its owning feature. */
export type ArtifactDetailRouteConfig<Tab extends ArtifactDetailTab> = {
  aliases?: Readonly<Record<string, Tab>>;
  tabs: readonly [Tab, ...Tab[]];
};

/**
 * Read and write the shell's top-level tab through the host navigation port.
 * Hosts key the shell by entity identity; pending reveals are scoped to its path.
 * Wire `onActivePanelReady` to the shell before using `selectTabThenReveal`.
 */
export function useArtifactDetailTabRoute<Tab extends ArtifactDetailTab>(
  config: ArtifactDetailRouteConfig<Tab>
) {
  const route = useTabParam<Tab>({
    defaultTab: config.tabs[0],
    historyMode: TabHistoryMode.Push,
    tabAliases: config.aliases,
    validTabs: config.tabs,
  });
  const path = usePath();
  const readyPanel = useRef<{ path: string; tab: Tab } | null>(null);
  const [bindingError, setBindingError] = useState<Error | null>(null);
  if (bindingError) {
    throw bindingError;
  }
  const pendingReveal = useRef<{
    path: string;
    reveal: () => void;
    tab: Tab;
  } | null>(null);

  useEffect(() => {
    const pending = pendingReveal.current;
    if (pending && (pending.path !== path || pending.tab !== route.activeTab)) {
      pendingReveal.current = null;
    }
  }, [route.activeTab, path]);

  useEffect(
    () => () => {
      pendingReveal.current = null;
      readyPanel.current = null;
    },
    []
  );

  const selectTabThenReveal = useCallback(
    (tab: Tab, reveal: () => void) => {
      if (!config.tabs.includes(tab)) {
        return;
      }
      // A commit-only fallback can precede Radix Presence's body mount.
      // Reject an unbound host through its React error boundary before navigating.
      if (
        readyPanel.current?.path !== path ||
        readyPanel.current.tab !== route.activeTab
      ) {
        setBindingError(new Error(ARTIFACT_DETAIL_PANEL_READY_REQUIRED));
        return;
      }
      if (tab === route.activeTab) {
        pendingReveal.current = null;
        reveal();
        return;
      }
      pendingReveal.current = { path, reveal, tab };
      route.setActiveTab(tab);
    },
    [config.tabs, path, route.activeTab, route.setActiveTab]
  );

  const setActiveTab = useCallback(
    (tab: string) => {
      pendingReveal.current = null;
      route.setActiveTab(tab);
    },
    [route.setActiveTab]
  );

  /** Wire to the shell so Radix's committed panel body precedes reveal. */
  const onActivePanelReady = useCallback(
    (tab: Tab) => {
      if (tab === route.activeTab) {
        readyPanel.current = { path, tab };
      }
      const pending = pendingReveal.current;
      if (
        pending?.path === path &&
        pending.tab === tab &&
        tab === route.activeTab
      ) {
        pendingReveal.current = null;
        pending.reveal();
      }
    },
    [path, route.activeTab]
  );

  return { ...route, onActivePanelReady, selectTabThenReveal, setActiveTab };
}

/** Missing shell readiness is an integration error, never a silently lost reveal. */
export const ARTIFACT_DETAIL_PANEL_READY_REQUIRED =
  "ArtifactDetailPanelReadyRequired";
