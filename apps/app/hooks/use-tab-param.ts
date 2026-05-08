"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

type UseTabParamConfig<T extends string> = {
  defaultTab: T;
  paramName?: string;
  validTabs: readonly T[];
};

type UseTabParamResult<T extends string> = {
  activeTab: T;
  setActiveTab: (tab: string) => void;
};

export function useTabParam<T extends string>(
  config: UseTabParamConfig<T>
): UseTabParamResult<T> {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const key = config.paramName ?? "tab";
  const raw = searchParams.get(key);
  const activeTab =
    raw !== null && config.validTabs.includes(raw as T)
      ? (raw as T)
      : config.defaultTab;

  const setActiveTab = useCallback(
    (tab: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (tab === config.defaultTab) {
        params.delete(key);
      } else {
        params.set(key, tab);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, key, config.defaultTab]
  );

  return { activeTab, setActiveTab };
}
