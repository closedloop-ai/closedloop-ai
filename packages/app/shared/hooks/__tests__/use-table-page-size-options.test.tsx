import {
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import { useTablePageSizeOptions } from "../use-table-page-size-options";

function renderWithFlag(requestedPageSize: number, enabled: boolean) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY] : [],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
  return renderHook(() => useTablePageSizeOptions(requestedPageSize), {
    wrapper,
  });
}

/**
 * An adapter that has not answered yet — the state PostHog is in for the first
 * frames after mount, and the one the static adapter above cannot express
 * (implementing no `useFeatureFlagResolved`, it reads as permanently resolved).
 */
function renderUnresolved(requestedPageSize: number) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider
      adapter={{
        useFeatureFlagEnabled: () => false,
        useFeatureFlagResolved: () => false,
      }}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
  return renderHook(() => useTablePageSizeOptions(requestedPageSize), {
    wrapper,
  });
}

describe("useTablePageSizeOptions", () => {
  it("offers only the shipped ladder while the flag is off", () => {
    const { result } = renderWithFlag(25, false);

    expect(result.current.options).toEqual([...TABLE_PAGE_SIZE_OPTIONS]);
    expect(result.current.options).not.toContain(250);
    expect(result.current.options).not.toContain(500);
  });

  it("offers 250 and 500 with the flag on", () => {
    const { result } = renderWithFlag(25, true);

    expect(result.current.options).toEqual([
      ...TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
    ]);
  });

  it("keeps a large page size while the flag is on", () => {
    expect(renderWithFlag(500, true).result.current.pageSize).toBe(500);
    expect(renderWithFlag(250, true).result.current.pageSize).toBe(250);
  });

  it("degrades a stale large page size to a legal one once the flag is off", () => {
    // The failure this prevents: a 500 persisted while the flag was on, sent as
    // a `limit` after it is turned off, answered with a 400 by Sessions.
    const { result } = renderWithFlag(500, false);

    expect(result.current.pageSize).toBe(100);
    expect(result.current.options).toContain(result.current.pageSize);
  });

  /**
   * ISS-9692 (whitlockk review) — an UNRESOLVED flag is not a flag that said no.
   *
   * This value keys the Sessions and Branches list reads. Reading the bare
   * `useFeatureFlagEnabledOptional`, an enabled viewer holding 500 resolved to
   * 100 for the first frames and every caller happily fetched that page before
   * refetching at 500. `isReady` is the distinction the callers gate on; without
   * it there is nothing in the hook's contract for them to wait for.
   */
  it("reports the flag as not yet ready while it is still resolving", () => {
    const { result } = renderUnresolved(500);

    expect(result.current.isReady).toBe(false);
    // And it still answers with a SAFE size meanwhile — a caller that ignores
    // readiness must never be handed a rung the closed ladder cannot serve.
    expect(result.current.pageSize).toBe(100);
  });

  it("reports the flag as ready once it has answered", () => {
    expect(renderWithFlag(500, true).result.current.isReady).toBe(true);
    expect(renderWithFlag(500, false).result.current.isReady).toBe(true);
  });

  it("resolves to a size the offered ladder actually contains", () => {
    // Whatever a corrupt store hands over, the number the caller requests with
    // is always one the select beside it can display.
    for (const stored of [0, 7, 42, 137, 999, Number.NaN]) {
      const { result } = renderWithFlag(stored, false);
      expect(result.current.options).toContain(result.current.pageSize);
    }
  });
});
