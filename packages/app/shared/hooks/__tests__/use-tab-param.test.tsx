import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { useTabParam } from "../use-tab-param";

/**
 * Navigation-port coverage for the migrated app-core hook (FEA-1510),
 * exercising the surface-agnostic memory adapter the desktop renderer uses.
 */
const VALID_TABS = ["overview", "activity", "settings"] as const;
type TestTab = (typeof VALID_TABS)[number];

function renderTabParam(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = renderHook(
    () =>
      useTabParam<TestTab>({
        defaultTab: "overview",
        validTabs: VALID_TABS,
      }),
    { wrapper }
  );
  return { nav, ...view };
}

function queryOf(href: string): URLSearchParams {
  const queryStart = href.indexOf("?");
  return new URLSearchParams(
    queryStart === -1 ? "" : href.slice(queryStart + 1)
  );
}

describe("useTabParam (navigation port)", () => {
  test("restores the active tab from the URL on mount", () => {
    const { result } = renderTabParam("/project?tab=activity");

    expect(result.current.activeTab).toBe("activity");
  });

  test("falls back to the default tab when the param is absent", () => {
    const { result } = renderTabParam("/project");

    expect(result.current.activeTab).toBe("overview");
  });

  test("falls back to the default tab for an invalid param value", () => {
    const { result } = renderTabParam("/project?tab=bogus");

    expect(result.current.activeTab).toBe("overview");
  });

  test("setActiveTab to a non-default tab sets the param, preserving unrelated ones", () => {
    const { result, nav } = renderTabParam("/project?filter=open");

    act(() => {
      result.current.setActiveTab("settings");
    });

    const params = queryOf(nav.getCurrentHref());
    expect(params.get("tab")).toBe("settings");
    expect(params.get("filter")).toBe("open");
    expect(result.current.activeTab).toBe("settings");
  });

  test("setActiveTab to the default tab removes the param (default-tab removal)", () => {
    const { result, nav } = renderTabParam("/project?tab=settings&filter=open");

    act(() => {
      result.current.setActiveTab("overview");
    });

    const params = queryOf(nav.getCurrentHref());
    expect(params.get("tab")).toBeNull();
    expect(params.get("filter")).toBe("open");
    expect(result.current.activeTab).toBe("overview");
  });
});
