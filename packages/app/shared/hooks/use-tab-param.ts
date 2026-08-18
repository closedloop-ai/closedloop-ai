"use client";

import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback } from "react";

type UseTabParamConfig<T extends string> = {
  defaultTab: T;
  paramName?: string;
  validTabs: readonly T[];
  /**
   * Optional legacy-value → canonical-tab map. A `?<paramName>=<alias>` whose
   * value is a key here resolves to the mapped canonical tab (which must be a
   * `validTabs` member). Lets a URL-facing rename accept the old value as a
   * compat alias without changing the underlying tab/filter contract — e.g.
   * FEA-4137 accepts a legacy `?tab=features` as the canonical `issues` tab.
   * The canonical value is what `setActiveTab` writes back, so a deep-link
   * arriving on the alias is normalized to the canonical form on the next write.
   */
  tabAliases?: Readonly<Record<string, T>>;
};

type UseTabParamResult<T extends string> = {
  activeTab: T;
  setActiveTab: (tab: string) => void;
};

/**
 * Durable, URL-synced tab state — the standard for every independent tabbed
 * screen/sub-view (FEA-3557). PREFER this over a raw `useState`/`defaultValue`
 * tab so the active tab is a shareable permalink: deep-linking `?tab=<value>`
 * restores it, and refresh / back-forward / copy-link all preserve it.
 *
 * Contract:
 * - Reads the tab from `?<paramName>=` (defaults to `tab`); an absent or invalid
 *   value falls back to `defaultTab`.
 * - `setActiveTab` writes via the navigation port with `scroll: false` (no jump)
 *   and OMITS the default tab from the URL, keeping links canonical.
 * - Goes through `packages/navigation`, so it works on web (App Router) AND the
 *   desktop renderer (IPC nav) — never call `useRouter`/`useSearchParams`
 *   directly in shared tab code.
 *
 * Conventions for adopters:
 * - Give nested sub-tabs a DISTINCT `paramName` (e.g. `view`, `kind`) so a
 *   sub-view never collides with a top-level `?tab=` on the same route.
 * - Build `validTabs` from only the tabs actually rendered when they are
 *   conditionally shown (capability/flag-gated), so a deep-link to a hidden tab
 *   falls back to the default instead of selecting nothing.
 */
export function useTabParam<T extends string>(
  config: UseTabParamConfig<T>
): UseTabParamResult<T> {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();

  const key = config.paramName ?? "tab";
  const raw = searchParams.get(key);
  const activeTab = resolveActiveTab(raw, config);

  const setActiveTab = useCallback(
    (tab: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (tab === config.defaultTab) {
        params.delete(key);
      } else {
        params.set(key, tab);
      }
      const qs = params.toString();
      navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
        scroll: false,
      });
    },
    [navigation, pathname, searchParams, key, config.defaultTab]
  );

  return { activeTab, setActiveTab };
}

/**
 * Resolve the raw `?tab=` value to a canonical tab: a valid tab passes through,
 * a known legacy alias maps to its canonical tab, and anything else (absent or
 * unrecognized) falls back to the default.
 */
function resolveActiveTab<T extends string>(
  raw: string | null,
  config: UseTabParamConfig<T>
): T {
  if (raw === null) {
    return config.defaultTab;
  }
  if (config.validTabs.includes(raw as T)) {
    return raw as T;
  }
  const aliased = config.tabAliases?.[raw];
  if (aliased !== undefined && config.validTabs.includes(aliased)) {
    return aliased;
  }
  return config.defaultTab;
}
