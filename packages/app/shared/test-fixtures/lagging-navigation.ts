import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import type {
  NavigationActions,
  NavigationAdapter,
  ReadonlySearchParams,
} from "@repo/navigation/navigation-adapter";
import { useMemo } from "react";

type LaggingNavigation = Omit<MemoryNavigation, "adapter"> & {
  adapter: NavigationAdapter;
  /** Every href passed to `replace`, in call order, whether or not it has landed. */
  replacedHrefs: string[];
  /** Lands the newest queued replace, as the web router does a tick later; a newer replace discards an older unlanded one. */
  landReplaces: () => void;
};

/**
 * A memory adapter whose `replace` does not reach the search-params snapshot
 * until `landReplaces`, the window in which the web App Router still reports the
 * previous query to every hook that renders. Like the production App Router, it
 * hands each hook instance its own search-params object for one router state.
 */
export function createLaggingNavigation(
  initialPath: string
): LaggingNavigation {
  const memory = createMemoryNavigation({ initialPath, orgSlug: "org" });
  const replacedHrefs: string[] = [];
  const queued: string[] = [];
  const actions: NavigationActions = {
    navigate: memory.navigate,
    back: noop,
    forward: noop,
    refresh: noop,
    replace: (href: string) => {
      replacedHrefs.push(href);
      queued.push(href);
    },
  };
  const adapter: NavigationAdapter = {
    ...memory.adapter,
    useNavigationActions: () => actions,
    useSearchParamsSnapshot: (): ReadonlySearchParams => {
      const shared = memory.adapter.useSearchParamsSnapshot();
      return useMemo(() => new URLSearchParams(shared.toString()), [shared]);
    },
  };
  return {
    ...memory,
    adapter,
    replacedHrefs,
    landReplaces: () => {
      const newest = queued.splice(0).at(-1);
      if (newest !== undefined) {
        memory.replace(newest);
      }
    },
  };
}

function noop() {
  return undefined;
}
