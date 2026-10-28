import {
  SessionsListAnalyticsSignal,
  SharedAnalyticsComponent,
  Surface,
  type SurfaceAnalyticsCapture,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import { useSessionsListAnalytics } from "../use-sessions-list-analytics";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const capture = vi.fn<SurfaceAnalyticsCapture>();

type HookInput = Parameters<typeof useSessionsListAnalytics>[0];

const PENDING: HookInput = {
  isError: false,
  isPending: true,
  isPlaceholderPage: false,
  isServerDriven: true,
  rowCount: 0,
};

let restoreWidth: (() => void) | undefined;

beforeEach(() => {
  capture.mockReset();
});

afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = undefined;
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      {children}
    </SurfaceAnalyticsProvider>
  );
}

function observedCalls() {
  return capture.mock.calls.filter(
    ([event]) => event === SurfaceAnalyticsEvent.SessionsListObserved
  );
}

describe("Sessions list analytics (ISS-9531)", () => {
  it("emits one bounded loaded sample at the first settled read, and none while pending", () => {
    const { rerender } = renderHook(
      (input: HookInput) => useSessionsListAnalytics(input),
      { initialProps: PENDING, wrapper }
    );
    expect(observedCalls()).toHaveLength(0);

    rerender({ ...PENDING, isPending: false, rowCount: 12 });
    rerender({ ...PENDING, isPending: false, rowCount: 30 });

    expect(observedCalls()).toHaveLength(1);
    const [, properties] = observedCalls()[0] ?? [];
    expect(properties).toEqual({
      duration_capped: false,
      duration_ms: expect.any(Number),
      row_count_bucket: "6-20",
      server_driven: true,
      signal: SessionsListAnalyticsSignal.Loaded,
      surface: Surface.Web,
    });
  });

  it("does not count a placeholder page as loaded", () => {
    renderHook((input: HookInput) => useSessionsListAnalytics(input), {
      initialProps: {
        ...PENDING,
        isPending: false,
        isPlaceholderPage: true,
        rowCount: 25,
      },
      wrapper,
    });
    expect(observedCalls()).toHaveLength(0);
  });

  it("reports each transition into a read error, and no loaded sample for it", () => {
    const { rerender } = renderHook(
      (input: HookInput) => useSessionsListAnalytics(input),
      { initialProps: PENDING, wrapper }
    );
    const failed = { ...PENDING, isError: true, isPending: false };
    rerender(failed);
    rerender(failed);
    rerender({ ...PENDING, isPending: true });
    rerender(failed);

    expect(observedCalls().map(([, properties]) => properties)).toEqual([
      {
        server_driven: true,
        signal: SessionsListAnalyticsSignal.LoadFailure,
        surface: Surface.Web,
      },
      {
        server_driven: true,
        signal: SessionsListAnalyticsSignal.LoadFailure,
        surface: Surface.Web,
      },
    ]);
  });

  it("times a recovered load from the retry, not from mount (tamsinb review, #9123)", () => {
    let nowMs = 0;
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => nowMs);
    try {
      const { rerender } = renderHook(
        (input: HookInput) => useSessionsListAnalytics(input),
        { initialProps: PENDING, wrapper }
      );
      nowMs = 1000;
      rerender({ ...PENDING, isError: true, isPending: false });
      nowMs = 50_000;
      rerender(PENDING);
      nowMs = 50_300;
      rerender({ ...PENDING, isPending: false, rowCount: 3 });

      const loaded = observedCalls().find(
        ([, properties]) =>
          properties.signal === SessionsListAnalyticsSignal.Loaded
      );
      expect(loaded?.[1]).toEqual(
        expect.objectContaining({ duration_capped: false, duration_ms: 300 })
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("does not count a bookmarked page past the end as a failed read (whitlockk review, #9123)", () => {
    restoreWidth = stubContainerWidthPx(1440);
    render(pastEndSurface(undefined));
    expect(observedCalls()).toHaveLength(0);
  });

  it("still reports a failed read through the surface", () => {
    restoreWidth = stubContainerWidthPx(1440);
    render(pastEndSurface(SessionsListReadState.Error));
    expect(observedCalls().map(([, properties]) => properties.signal)).toEqual([
      SessionsListAnalyticsSignal.LoadFailure,
    ]);
  });

  it("is wired into the shared Sessions surface beside its exposure event", () => {
    restoreWidth = stubContainerWidthPx(1440);
    const rows = [createSessionTableRowFixture({ id: "ses-analytics-1" })];
    render(
      <AppCoreStoryProviders>
        <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
          <SessionsListSurfaceV2
            controlledView={{
              onChange: () => undefined,
              totalRows: rows.length,
              value: {
                dateRange: DEFAULT_DATE_RANGE,
                facets: DEFAULT_SESSION_FACET_FILTERS,
                grouping: EMPTY_TABLE_GROUPING,
                page: 0,
                scopeUserId: null,
                sortBy: null,
                sortDir: "desc",
                visibleColumnIds: new Set(["status"]),
              },
            }}
            rows={rows}
            usage={undefined}
          />
        </SurfaceAnalyticsProvider>
      </AppCoreStoryProviders>
    );

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.SharedComponentRendered,
      expect.objectContaining({
        component: SharedAnalyticsComponent.SessionsListSurfaceV2,
      })
    );
    expect(observedCalls()).toHaveLength(1);
    expect(observedCalls()[0]?.[1]).toEqual(
      expect.objectContaining({
        row_count_bucket: "1-5",
        signal: SessionsListAnalyticsSignal.Loaded,
      })
    );
  });
});

/**
 * A server-driven host asking for page 5 of a 30-row list: the read succeeded
 * and returned no rows, so the surface owes a page correction, not a failure.
 */
function pastEndSurface(readState: SessionsListReadState | undefined) {
  return (
    <AppCoreStoryProviders>
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <SessionsListSurfaceV2
          controlledView={{
            onChange: () => undefined,
            readState,
            totalRows: 30,
            value: {
              dateRange: DEFAULT_DATE_RANGE,
              facets: DEFAULT_SESSION_FACET_FILTERS,
              grouping: EMPTY_TABLE_GROUPING,
              page: 5,
              scopeUserId: null,
              sortBy: null,
              sortDir: "desc",
              visibleColumnIds: new Set(["status"]),
            },
          }}
          rows={[]}
          usage={undefined}
        />
      </SurfaceAnalyticsProvider>
    </AppCoreStoryProviders>
  );
}
