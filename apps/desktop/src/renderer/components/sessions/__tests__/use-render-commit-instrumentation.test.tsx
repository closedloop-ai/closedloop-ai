import { render } from "@testing-library/react";
import { Profiler, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type RenderCommitEvent,
  RendererRenderView,
} from "../../../../shared/render-commit-event";
import { RenderCommitTelemetryProvider } from "../render-commit-telemetry-context";
import {
  resolveSessionsDetailCause,
  resolveSessionsListCause,
  type SessionsListCauseInputs,
  useRenderCommitInstrumentation,
} from "../use-render-commit-instrumentation";

const baseListInputs: SessionsListCauseInputs = {
  page: 0,
  search: undefined,
  statuses: [],
  repositories: [],
  sortKey: null,
  sortDir: "desc",
  dateRange: "7d",
  isBackgroundRefetch: false,
};

function ListHarness({
  inputs,
  itemCount,
}: {
  inputs: SessionsListCauseInputs;
  itemCount: number;
}) {
  const onRender = useRenderCommitInstrumentation({
    view: RendererRenderView.SessionsList,
    itemCount,
    causeInputs: inputs,
    resolveCause: resolveSessionsListCause,
  });
  return (
    <Profiler id="sessions_list" onRender={onRender}>
      <div>list</div>
    </Profiler>
  );
}

function renderListHarness(inputs: SessionsListCauseInputs, itemCount: number) {
  const report = vi.fn<(event: RenderCommitEvent) => void>();
  const utils = render(
    <RenderCommitTelemetryProvider reportRenderCommit={report}>
      <ListHarness inputs={inputs} itemCount={itemCount} />
    </RenderCommitTelemetryProvider>
  );
  const rerenderWith = (inputs: SessionsListCauseInputs, itemCount: number) =>
    utils.rerender(
      <RenderCommitTelemetryProvider reportRenderCommit={report}>
        <ListHarness inputs={inputs} itemCount={itemCount} />
      </RenderCommitTelemetryProvider>
    );
  return { report, rerenderWith };
}

describe("useRenderCommitInstrumentation", () => {
  it("emits a mount wide event with the view, item count, and finite timing", () => {
    const { report } = renderListHarness(baseListInputs, 25);

    expect(report).toHaveBeenCalledTimes(1);
    const event = report.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      view: RendererRenderView.SessionsList,
      phase: "mount",
      cause: "mount",
      itemCount: 25,
    });
    expect(Number.isFinite(event?.actualMs)).toBe(true);
    expect(Number.isFinite(event?.baseMs)).toBe(true);
  });

  it.each([
    [{ page: 1 }, "paginate"],
    [{ search: "needle" }, "search"],
    [{ statuses: ["active"] }, "filter"],
    [{ repositories: ["closedloop-ai/symphony-alpha"] }, "filter"],
    [{ sortKey: "cost" }, "sort"],
    [{ sortDir: "asc" }, "sort"],
    [{ dateRange: "30d" }, "date_range"],
    [{ isBackgroundRefetch: true }, "refresh"],
  ])("attributes an update to cause %o → %s", (mutation, expectedCause) => {
    const { report, rerenderWith } = renderListHarness(baseListInputs, 25);
    report.mockClear();

    rerenderWith({ ...baseListInputs, ...mutation }, 25);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      phase: "update",
      cause: expectedCause,
    });
  });

  it("attributes a commit with no tracked input change to a plain rerender", () => {
    const { report, rerenderWith } = renderListHarness(baseListInputs, 25);
    report.mockClear();

    // New object, identical values, different item count (a content refresh that
    // changed no tracked interaction input).
    rerenderWith({ ...baseListInputs }, 40);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      phase: "update",
      cause: "rerender",
      itemCount: 40,
    });
  });

  it("prioritizes pagination over a simultaneous background refetch", () => {
    const { report, rerenderWith } = renderListHarness(baseListInputs, 25);
    report.mockClear();

    rerenderWith({ ...baseListInputs, page: 2, isBackgroundRefetch: true }, 25);

    expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: "paginate" });
  });

  // SessionsView's filter/sort/date-range handlers reset the page to 0, so from
  // a non-first page those gestures change `page` AND their own input in one
  // commit. The cause must be the gesture, not `paginate`.
  it.each([
    [{ statuses: ["active"] }, "filter"],
    [{ sortKey: "cost" }, "sort"],
    [{ dateRange: "30d" }, "date_range"],
  ])("attributes %o to its gesture even when the page is reset to 0 in the same commit", (mutation, expectedCause) => {
    const fromPageTwo = { ...baseListInputs, page: 2 };
    const { report, rerenderWith } = renderListHarness(fromPageTwo, 25);
    report.mockClear();

    // The gesture also resets page 2 → 0.
    rerenderWith({ ...fromPageTwo, ...mutation, page: 0 }, 25);

    expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: expectedCause });
  });

  it("still attributes a genuine page change (nothing else moved) to paginate", () => {
    const fromPageTwo = { ...baseListInputs, page: 2 };
    const { report, rerenderWith } = renderListHarness(fromPageTwo, 25);
    report.mockClear();

    rerenderWith({ ...fromPageTwo, page: 3 }, 25);

    expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: "paginate" });
  });

  it("attributes refresh only on the rising edge; a still-fetching commit is a rerender", () => {
    const { report, rerenderWith } = renderListHarness(baseListInputs, 25);
    report.mockClear();

    // false → true: the refresh edge.
    rerenderWith({ ...baseListInputs, isBackgroundRefetch: true }, 25);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: "refresh" });
    report.mockClear();

    // true → true: a later in-flight commit is a plain rerender, not refresh.
    rerenderWith({ ...baseListInputs, isBackgroundRefetch: true }, 30);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: "rerender" });
  });

  it("derives cause against the previous COMMIT, not the previous render (StrictMode-safe)", () => {
    const report = vi.fn<(event: RenderCommitEvent) => void>();
    const utils = render(
      <StrictMode>
        <RenderCommitTelemetryProvider reportRenderCommit={report}>
          <ListHarness inputs={baseListInputs} itemCount={25} />
        </RenderCommitTelemetryProvider>
      </StrictMode>
    );
    report.mockClear();

    utils.rerender(
      <StrictMode>
        <RenderCommitTelemetryProvider reportRenderCommit={report}>
          <ListHarness inputs={{ ...baseListInputs, page: 1 }} itemCount={25} />
        </RenderCommitTelemetryProvider>
      </StrictMode>
    );

    // StrictMode double-invokes the render phase but commits once, so exactly one
    // update event fires and it is attributed correctly — the diff is never
    // corrupted by the doubled render.
    const updates = report.mock.calls
      .map((call) => call[0])
      .filter((event) => event.phase === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ cause: "paginate" });
  });
});

describe("session-detail render-commit instrumentation", () => {
  function DetailHarness({
    sessionId,
    itemCount,
  }: {
    sessionId: string;
    itemCount: number;
  }) {
    const onRender = useRenderCommitInstrumentation({
      view: RendererRenderView.SessionsDetail,
      itemCount,
      causeInputs: { sessionId },
      resolveCause: resolveSessionsDetailCause,
    });
    return (
      <Profiler id="sessions_detail" onRender={onRender}>
        <div>detail</div>
      </Profiler>
    );
  }

  it("emits a detail mount event with the rendered event count", () => {
    const report = vi.fn<(event: RenderCommitEvent) => void>();
    render(
      <RenderCommitTelemetryProvider reportRenderCommit={report}>
        <DetailHarness itemCount={12} sessionId="ses-1" />
      </RenderCommitTelemetryProvider>
    );

    expect(report.mock.calls[0]?.[0]).toMatchObject({
      view: RendererRenderView.SessionsDetail,
      phase: "mount",
      cause: "mount",
      itemCount: 12,
    });
  });

  it("treats in-place detail commits as plain rerenders", () => {
    const report = vi.fn<(event: RenderCommitEvent) => void>();
    const ui = (sessionId: string, itemCount: number) => (
      <RenderCommitTelemetryProvider reportRenderCommit={report}>
        <DetailHarness itemCount={itemCount} sessionId={sessionId} />
      </RenderCommitTelemetryProvider>
    );
    const utils = render(ui("ses-1", 0));
    report.mockClear();

    utils.rerender(ui("ses-1", 12));

    expect(report.mock.calls[0]?.[0]).toMatchObject({
      phase: "update",
      cause: "rerender",
      itemCount: 12,
    });
  });
});

describe("RenderCommitTelemetryProvider default", () => {
  it("is a no-op when no provider is mounted (renders without throwing)", () => {
    function BareHarness() {
      const onRender = useRenderCommitInstrumentation({
        view: RendererRenderView.SessionsList,
        itemCount: 1,
        causeInputs: baseListInputs,
        resolveCause: resolveSessionsListCause,
      });
      return (
        <Profiler id="bare" onRender={onRender}>
          <div>bare</div>
        </Profiler>
      );
    }

    expect(() => render(<BareHarness />)).not.toThrow();
  });
});
