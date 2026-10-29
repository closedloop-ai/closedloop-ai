/**
 * The one fan-in point for every priority menu: the documents grid cells, the
 * bulk bar, the document metadata bar, the project detail panel and the
 * create-project modal all read their option order from this hook, so this is
 * the only place the gate's actual behavioural change is observable.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const GATE = vi.hoisted(() => ({ open: false }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => GATE.open,
  useFeatureFlagEnabledOptional: () => GATE.open,
}));

import { usePriorityOptions } from "../use-priority-options";

// Pinned literally so neither expectation is read out of the module it polices.
const URGENT_FIRST = ["URGENT", "HIGH", "MEDIUM", "LOW"];
const LOWEST_FIRST = ["LOW", "MEDIUM", "HIGH", "URGENT"];

describe("usePriorityOptions", () => {
  beforeEach(() => {
    GATE.open = false;
  });

  it("keeps the pre-gate reading order while the gate is closed", () => {
    expect([...renderHook(() => usePriorityOptions()).result.current]).toEqual(
      LOWEST_FIRST
    );
  });

  it("offers the semantic rank once the gate is open", () => {
    GATE.open = true;

    expect([...renderHook(() => usePriorityOptions()).result.current]).toEqual(
      URGENT_FIRST
    );
  });

  it("offers the same values either way, so no option is gained or lost", () => {
    const closed = [...renderHook(() => usePriorityOptions()).result.current];
    GATE.open = true;
    const open = [...renderHook(() => usePriorityOptions()).result.current];

    expect(open.slice().sort()).toEqual(closed.slice().sort());
    expect(open).not.toEqual(closed);
  });
});
