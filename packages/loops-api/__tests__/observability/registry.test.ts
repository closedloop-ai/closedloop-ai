import { describe, expect, it } from "vitest";

import { LoopHarness } from "../../src/desktop-request";
import {
  getObservabilityRegistryEntry,
  ObservabilityAdapterStatus,
  ObservabilityCapability,
  selectObservabilityAdapter,
} from "../../src/observability";
import { makeClock, makeContext } from "./fixtures";

describe("selectObservabilityAdapter (AC-003)", () => {
  const now = makeClock();

  it("selects a Claude adapter declaring full capabilities", () => {
    const adapter = selectObservabilityAdapter(
      LoopHarness.Claude,
      makeContext(LoopHarness.Claude, now)
    );
    expect(adapter).not.toBeNull();
    expect(adapter?.harness).toBe(LoopHarness.Claude);
    expect(adapter?.capabilities.spawn).toBe(ObservabilityCapability.Supported);
    expect(adapter?.capabilities.agent).toBe(ObservabilityCapability.Supported);
  });

  it("selects a Codex adapter that declares spawn/agent unsupported (AC-002)", () => {
    const adapter = selectObservabilityAdapter(
      LoopHarness.Codex,
      makeContext(LoopHarness.Codex, now)
    );
    expect(adapter).not.toBeNull();
    expect(adapter?.capabilities.tool).toBe(ObservabilityCapability.Supported);
    expect(adapter?.capabilities.spawn).toBe(
      ObservabilityCapability.Unsupported
    );
    expect(adapter?.capabilities.agent).toBe(
      ObservabilityCapability.Unsupported
    );
    expect(adapter?.capabilities.tokenUsage).toBe(
      ObservabilityCapability.Supported
    );
  });

  it("returns null for planned/placeholder harnesses (registry-only addition)", () => {
    for (const harness of [LoopHarness.Cursor, LoopHarness.OpenCode]) {
      const entry = getObservabilityRegistryEntry(harness);
      expect(entry.status).toBe(ObservabilityAdapterStatus.Planned);
      expect(entry.factory).toBeUndefined();
      expect(
        selectObservabilityAdapter(harness, makeContext(harness, now))
      ).toBeNull();
    }
  });
});
