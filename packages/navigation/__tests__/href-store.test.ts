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

  it("forward restores an entry and a new navigation drops the forward branch", () => {
    const store = createHrefStore({ initialHref: "/start" });
    store.actions.navigate("/first?tab=details");
    store.actions.navigate("/second?tab=activity");

    store.actions.back();
    expect(store.getHref()).toBe("/first?tab=details");
    expect(store.canGoForward()).toBe(true);
    store.actions.forward();
    expect(store.getHref()).toBe("/second?tab=activity");
    expect(store.getSearchSnapshot().get("tab")).toBe("activity");

    store.actions.back();
    store.actions.navigate("/third?tab=artifact");
    expect(store.canGoForward()).toBe(false);
    store.actions.forward();
    expect(store.getHref()).toBe("/third?tab=artifact");
  });

  it("records visited history including replace targets", () => {
    const store = createHrefStore({ initialHref: "/start" });

    store.actions.navigate("/first");
    store.actions.replace("/second");
    expect(store.getHistory()).toEqual(["/start", "/first", "/second"]);
  });

  it("retains the forward entry when replacing after Back", () => {
    const store = createHrefStore({ initialHref: "/branch?tab=legacy" });
    store.actions.navigate("/branch?tab=details");
    store.actions.back();
    store.actions.replace("/branch?tab=sessions");
    expect(store.canGoForward()).toBe(true);
    store.actions.forward();
    expect(store.getHref()).toBe("/branch?tab=details");
    store.actions.back();
    expect(store.getHref()).toBe("/branch?tab=sessions");
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

    store.actions.forward();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(onHrefChange).toHaveBeenLastCalledWith("/next");

    store.actions.replace("/again");
    expect(onHrefChange).toHaveBeenLastCalledWith("/again");
    expect(onHrefChange).toHaveBeenCalledTimes(4);
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
