import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { TabHistoryMode, useTabParam } from "../use-tab-param";

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

// FEA-4137: a legacy tab value maps to a canonical tab via `tabAliases`.
const ALIASED_VALID_TABS = ["overview", "issues"] as const;
type AliasedTab = (typeof ALIASED_VALID_TABS)[number];

function renderAliasedTabParam(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = renderHook(
    () =>
      useTabParam<AliasedTab>({
        defaultTab: "overview",
        validTabs: ALIASED_VALID_TABS,
        tabAliases: { features: "issues" },
      }),
    { wrapper }
  );
  return { nav, ...view };
}

function renderPushTabParam(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = renderHook(
    () => ({
      ...useTabParam<TestTab>({
        defaultTab: "overview",
        historyMode: TabHistoryMode.Push,
        tabAliases: { legacy: "activity" },
        validTabs: VALID_TABS,
      }),
      navigation: useNavigation(),
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
    expect(nav.getHistory()).toEqual([
      "/project?tab=settings&filter=open",
      "/project?filter=open",
    ]);
  });

  test("push mode preserves context and restores tabs through back and forward", () => {
    const initial =
      "/project?file=main&invocationAnchor=row-1&from=session&extra=kept";
    const { result, nav } = renderPushTabParam(initial);

    act(() => result.current.setActiveTab("activity"));
    expect(result.current.activeTab).toBe("activity");
    expect(queryOf(nav.getCurrentHref()).get("file")).toBe("main");
    expect(queryOf(nav.getCurrentHref()).get("invocationAnchor")).toBe("row-1");
    expect(queryOf(nav.getCurrentHref()).get("from")).toBe("session");
    expect(queryOf(nav.getCurrentHref()).get("extra")).toBe("kept");
    expect(nav.getHistory()).toHaveLength(2);

    act(() => result.current.navigation.back());
    expect(result.current.activeTab).toBe("overview");
    expect(nav.getCurrentHref()).toBe(initial);
    act(() => result.current.navigation.forward());
    expect(result.current.activeTab).toBe("activity");
    expect(nav.getHistory()).toHaveLength(2);
  });

  test("push mode avoids duplicate entries and replaces a legacy alias", () => {
    const { result, nav } = renderPushTabParam("/project?tab=legacy&file=main");
    expect(result.current.activeTab).toBe("activity");

    act(() => result.current.setActiveTab("activity"));
    expect(nav.getCurrentHref()).toBe("/project?tab=activity&file=main");
    expect(nav.getHistory()).toHaveLength(2);
    act(() => result.current.setActiveTab("activity"));
    expect(nav.getHistory()).toHaveLength(2);

    act(() => result.current.setActiveTab("unknown"));
    expect(nav.getCurrentHref()).toBe("/project?tab=activity&file=main");
  });

  test("push mode omits the default and makes it a navigable history entry", () => {
    const { result, nav } = renderPushTabParam(
      "/project?tab=activity&file=main"
    );

    act(() => result.current.setActiveTab("overview"));
    expect(nav.getCurrentHref()).toBe("/project?file=main");
    expect(result.current.activeTab).toBe("overview");
    act(() => result.current.navigation.back());
    expect(result.current.activeTab).toBe("activity");
  });

  test("replace mode rejects invalid selections without changing URL context", () => {
    const initial = "/project?tab=activity&file=main&from=session";
    const { result, nav } = renderTabParam(initial);

    act(() => result.current.setActiveTab("unknown"));

    expect(result.current.activeTab).toBe("activity");
    expect(nav.getCurrentHref()).toBe(initial);
    expect(nav.getHistory()).toEqual([initial]);
  });

  // FEA-4137: a legacy `?tab=features` deep-link must resolve to the canonical
  // `issues` tab so old project-page links (breadcrumbs, bookmarks) keep working
  // after the Feature → Issue rename.
  test("resolves a legacy alias param to its canonical tab", () => {
    const { result } = renderAliasedTabParam("/project?tab=features");

    expect(result.current.activeTab).toBe("issues");
  });

  test("a canonical alias-target value still resolves directly", () => {
    const { result } = renderAliasedTabParam("/project?tab=issues");

    expect(result.current.activeTab).toBe("issues");
  });

  test("an unknown value with aliases configured still falls back to default", () => {
    const { result } = renderAliasedTabParam("/project?tab=bogus");

    expect(result.current.activeTab).toBe("overview");
  });
});
