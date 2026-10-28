import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRoutingSelection,
  resetRoutingSelectionForTests,
  setRoutingAutoSelection,
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
  });

  it("hydrates a complete selection from storage", () => {
    storageMap.set(
      storageKey,
      JSON.stringify({
        mode: EngineerRoutingMode.LocalElectron,
        computeTargetId: "ct-stored",
        updatedAt: 42,
      })
    );

    expect(getRoutingSelection()).toEqual({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: "ct-stored",
      updatedAt: 42,
    });
  });

  // ISS-12617 removed the manual selection. A value an older build stored
  // with `source: "manual"` loads as an ordinary selection, so the next
  // automatic write (the Desktop repair) replaces it instead of being refused.
  it("loads a stored manual selection as an ordinary one that an automatic write replaces", () => {
    storageMap.set(
      storageKey,
      JSON.stringify({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "ct-stored",
        source: "manual",
        updatedAt: 42,
      })
    );

    expect(getRoutingSelection()).toEqual({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "ct-stored",
      updatedAt: 42,
    });

    setRoutingAutoSelection(EngineerRoutingMode.LocalElectron, "ct-local");
    expect(getRoutingSelection()).toMatchObject({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: "ct-local",
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
      updatedAt: 0,
    });
  });

  it("sets a selection and persists it", () => {
    setRoutingAutoSelection(EngineerRoutingMode.LocalElectron, "ct-123");
    const selection = getRoutingSelection();
    expect(selection.mode).toBe(EngineerRoutingMode.LocalElectron);
    expect(selection.computeTargetId).toBe("ct-123");
    expect(JSON.parse(storageMap.get(storageKey) ?? "{}")).toMatchObject({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: "ct-123",
    });
  });

  it("notifies listeners on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRoutingSelection(listener);

    setRoutingAutoSelection(EngineerRoutingMode.LocalElectron);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    setRoutingAutoSelection(EngineerRoutingMode.CloudRelay);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify when selection is unchanged", () => {
    const listener = vi.fn();
    subscribeRoutingSelection(listener);

    setRoutingAutoSelection(EngineerRoutingMode.LocalElectron);
    expect(listener).toHaveBeenCalledOnce();

    setRoutingAutoSelection(EngineerRoutingMode.LocalElectron);
    // Same mode + same computeTargetId = no change
    expect(listener).toHaveBeenCalledOnce();
  });

  it("preserves computeTargetId for both routing modes", () => {
    setRoutingAutoSelection(EngineerRoutingMode.CloudRelay, "ct-relay");
    expect(getRoutingSelection().computeTargetId).toBe("ct-relay");

    setRoutingAutoSelection(EngineerRoutingMode.LocalElectron, "ct-local");
    expect(getRoutingSelection().computeTargetId).toBe("ct-local");
  });
});
