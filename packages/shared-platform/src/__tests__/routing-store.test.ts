import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRoutingSelection,
  resetRoutingSelectionForTests,
  setRoutingAutoSelection,
  setRoutingManualSelection,
  subscribeRoutingSelection,
} from "../routing-store";
import { EngineerRoutingMode } from "../types";

// Mock localStorage for Node environment
const storageMap = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storageMap.set(key, value)),
  removeItem: vi.fn((key: string) => storageMap.delete(key)),
  clear: vi.fn(() => storageMap.clear()),
  get length() {
    return storageMap.size;
  },
  key: vi.fn(() => null),
};

describe("routing-store", () => {
  const storageKey = "engineer-routing-selection:v1";

  beforeEach(() => {
    // Simulate a browser environment
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", mockStorage);
    storageMap.clear();
    resetRoutingSelectionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns default selection initially", () => {
    const selection = getRoutingSelection();
    expect(selection.mode).toBe(EngineerRoutingMode.CloudRelay);
    expect(selection.computeTargetId).toBeNull();
    expect(selection.source).toBe("auto");
  });

  it("hydrates a complete manual selection from storage", () => {
    storageMap.set(
      storageKey,
      JSON.stringify({
        mode: EngineerRoutingMode.LocalElectron,
        computeTargetId: "ct-stored",
        source: "manual",
        updatedAt: 42,
      })
    );

    expect(getRoutingSelection()).toEqual({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: "ct-stored",
      source: "manual",
      updatedAt: 42,
    });
  });

  it("normalizes optional persisted fields", () => {
    storageMap.set(
      storageKey,
      JSON.stringify({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: 7,
        source: "future",
      })
    );

    const selection = getRoutingSelection();
    expect(selection).toMatchObject({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: null,
      source: "auto",
    });
    expect(selection.updatedAt).toBeGreaterThan(0);
  });

  it("ignores persisted selections with an invalid routing mode", () => {
    storageMap.set(
      storageKey,
      JSON.stringify({ mode: "future", computeTargetId: "ct-stored" })
    );

    expect(getRoutingSelection()).toEqual({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: null,
      source: "auto",
      updatedAt: 0,
    });
  });

  it("allows manual selection override", () => {
    setRoutingManualSelection(EngineerRoutingMode.LocalElectron, "ct-123");
    const selection = getRoutingSelection();
    expect(selection.mode).toBe(EngineerRoutingMode.LocalElectron);
    expect(selection.computeTargetId).toBe("ct-123");
    expect(selection.source).toBe("manual");
  });

  it("auto selection does not override manual", () => {
    setRoutingManualSelection(EngineerRoutingMode.LocalElectron);

    setRoutingAutoSelection(EngineerRoutingMode.CloudRelay, "ct-456");
    const selection = getRoutingSelection();
    expect(selection.mode).toBe(EngineerRoutingMode.LocalElectron);
    expect(selection.source).toBe("manual");
  });

  it("auto selection with force overrides manual", () => {
    setRoutingManualSelection(EngineerRoutingMode.LocalElectron);

    setRoutingAutoSelection(EngineerRoutingMode.CloudRelay, "ct-456", {
      force: true,
    });
    const selection = getRoutingSelection();
    expect(selection.mode).toBe(EngineerRoutingMode.CloudRelay);
    expect(selection.computeTargetId).toBe("ct-456");
  });

  it("notifies listeners on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRoutingSelection(listener);

    setRoutingManualSelection(EngineerRoutingMode.LocalElectron);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    setRoutingManualSelection(EngineerRoutingMode.CloudRelay);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify when selection is unchanged", () => {
    const listener = vi.fn();
    subscribeRoutingSelection(listener);

    setRoutingManualSelection(EngineerRoutingMode.CloudRelay);
    // First call changes source from auto to manual
    expect(listener).toHaveBeenCalledOnce();

    setRoutingManualSelection(EngineerRoutingMode.CloudRelay);
    // Same mode + same source + same computeTargetId = no change
    expect(listener).toHaveBeenCalledOnce();
  });

  it("preserves computeTargetId for both routing modes", () => {
    setRoutingManualSelection(EngineerRoutingMode.CloudRelay, "ct-relay");
    expect(getRoutingSelection().computeTargetId).toBe("ct-relay");

    setRoutingManualSelection(EngineerRoutingMode.LocalElectron, "ct-local");
    expect(getRoutingSelection().computeTargetId).toBe("ct-local");
  });
});
