import { describe, expect, it, vi } from "vitest";
import { createHrefStore } from "../href-store";

describe("createHrefStore", () => {
  it("starts at the initial href and reports path/search snapshots", () => {
    const store = createHrefStore({ initialHref: "/a/b?tab=active" });

    expect(store.getHref()).toBe("/a/b?tab=active");
    expect(store.getPath()).toBe("/a/b");
    expect(store.getSearchSnapshot().get("tab")).toBe("active");
    expect(store.canGoBack()).toBe(false);
  });

  it("navigate pushes, back pops, replace rewrites in place", () => {
    const store = createHrefStore({ initialHref: "/start" });

    store.actions.navigate("/first");
    store.actions.navigate("/second");
    expect(store.getHref()).toBe("/second");
    expect(store.canGoBack()).toBe(true);

    store.actions.back();
    expect(store.getHref()).toBe("/first");

    store.actions.replace("/replaced");
    expect(store.getHref()).toBe("/replaced");

    // back from a replaced mid-stack entry returns to the entry below it,
    // not the replaced-away one.
    store.actions.back();
    expect(store.getHref()).toBe("/start");
    expect(store.canGoBack()).toBe(false);
    store.actions.back();
    expect(store.getHref()).toBe("/start");
  });

  it("records visited history including replace targets", () => {
    const store = createHrefStore({ initialHref: "/start" });

    store.actions.navigate("/first");
    store.actions.replace("/second");
    expect(store.getHistory()).toEqual(["/start", "/first", "/second"]);
  });

  it("keeps the search snapshot referentially stable between changes", () => {
    const store = createHrefStore({ initialHref: "/a?x=1" });

    const first = store.getSearchSnapshot();
    expect(store.getSearchSnapshot()).toBe(first);

    store.actions.navigate("/b?x=2");
    const second = store.getSearchSnapshot();
    expect(second).not.toBe(first);
    expect(second.get("x")).toBe("2");
    expect(store.getSearchSnapshot()).toBe(second);
  });

  it("notifies subscribers and onHrefChange for internal actions", () => {
    const onHrefChange = vi.fn();
    const store = createHrefStore({ initialHref: "/start", onHrefChange });
    const listener = vi.fn();
    store.subscribe(listener);

    store.actions.navigate("/next");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onHrefChange).toHaveBeenLastCalledWith("/next");

    store.actions.back();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(onHrefChange).toHaveBeenLastCalledWith("/start");

    store.actions.replace("/again");
    expect(onHrefChange).toHaveBeenLastCalledWith("/again");
    expect(onHrefChange).toHaveBeenCalledTimes(3);
  });

  it("syncExternalHref pushes without invoking onHrefChange", () => {
    const onHrefChange = vi.fn();
    const store = createHrefStore({ initialHref: "/start", onHrefChange });
    const listener = vi.fn();
    store.subscribe(listener);

    store.syncExternalHref("/external?x=1");
    expect(store.getHref()).toBe("/external?x=1");
    expect(store.getSearchSnapshot().get("x")).toBe("1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onHrefChange).not.toHaveBeenCalled();

    // back() returns to the pre-external entry — external changes are real
    // history entries.
    store.actions.back();
    expect(store.getHref()).toBe("/start");
  });

  it("syncExternalHref is a no-op for the current href", () => {
    const store = createHrefStore({ initialHref: "/start" });
    const listener = vi.fn();
    store.subscribe(listener);

    store.syncExternalHref("/start");
    expect(listener).not.toHaveBeenCalled();
    expect(store.getHistory()).toEqual(["/start"]);
  });

  it("routes refresh to onRefresh", () => {
    const onRefresh = vi.fn();
    const store = createHrefStore({ onRefresh });

    store.actions.refresh();
    store.actions.refresh();
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops notifications", () => {
    const store = createHrefStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.actions.navigate("/next");
    expect(listener).not.toHaveBeenCalled();
  });
});
