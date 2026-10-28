import { describe, expect, it, vi } from "vitest";
import { RealtimeStatus } from "../port";
import { createStatusStore } from "../status";

describe("createStatusStore", () => {
  it("starts connecting and notifies only on a change", () => {
    const store = createStatusStore();
    const callback = vi.fn();
    store.subscribe(callback);
    expect(store.get()).toBe(RealtimeStatus.Connecting);

    store.set(RealtimeStatus.Connecting);
    expect(callback).not.toHaveBeenCalled();

    store.set(RealtimeStatus.Open);
    store.set(RealtimeStatus.Open);
    expect(callback.mock.calls).toEqual([[RealtimeStatus.Open]]);
    expect(store.get()).toBe(RealtimeStatus.Open);
  });

  it("ignores every set once closed", () => {
    const store = createStatusStore();
    const callback = vi.fn();
    store.subscribe(callback);

    store.set(RealtimeStatus.Closed);
    store.set(RealtimeStatus.Open);

    expect(store.get()).toBe(RealtimeStatus.Closed);
    expect(callback.mock.calls).toEqual([[RealtimeStatus.Closed]]);
  });

  it("stops notifying a callback once it unsubscribes", () => {
    const store = createStatusStore();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribe(kept);
    const unsubscribe = store.subscribe(dropped);

    unsubscribe();
    store.set(RealtimeStatus.Open);

    expect(kept).toHaveBeenCalledWith(RealtimeStatus.Open);
    expect(dropped).not.toHaveBeenCalled();
  });
});
