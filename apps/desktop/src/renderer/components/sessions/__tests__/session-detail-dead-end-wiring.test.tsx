/**
 * @description ISS-7249, on the PRODUCTION path.
 *
 * The hook's own suite proves the once-per-render-with-cause contract against a
 * spy. This one proves the contract is actually reached: the real
 * `SessionDetailView`, the real detail query, the real default reporter, and the
 * assertions read what crossed `window.desktopApi.recordDeadEndTelemetry`.
 * Deleting the call site in the view leaves the hook suite green and this one
 * red, which is the point.
 */
import { ApiError } from "@repo/app/shared/api/api-error";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeadEndFlowPhase,
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
  type DeadEndTelemetryPayload,
} from "../../../../shared/dead-end-telemetry-contract";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";

const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

const NOT_FOUND_HEADING = /session not found/i;
const UNAVAILABLE_HEADING = /session unavailable/i;
const MISSING_SESSION_ID = "does-not-exist";
/** Any path separator at all: a record that carried one is carrying a location. */
const PATH_SEPARATOR = /\//;

type DetailReader = (id: string) => Promise<unknown>;

function installDesktopApi(detail: DetailReader) {
  const recordDeadEndTelemetry =
    vi.fn<(payload: DeadEndTelemetryPayload) => Promise<{ ok: boolean }>>();
  recordDeadEndTelemetry.mockResolvedValue({ ok: true });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: { detail: vi.fn(detail) },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      recordDeadEndTelemetry,
    },
  });
  return recordDeadEndTelemetry;
}

function withProviders(ui: ReactElement) {
  return (
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
    >
      <DesktopAppCoreProvider>{ui}</DesktopAppCoreProvider>
    </NavigationProvider>
  );
}

function renderDetail(sessionId: string) {
  return render(
    withProviders(
      <SessionDetailView backHref="/sessions" sessionId={sessionId} />
    )
  );
}

function deadEndPayloads(
  report: ReturnType<typeof installDesktopApi>
): DeadEndTelemetryPayload[] {
  return report.mock.calls.map((call) => call[0]);
}

describe("SessionDetailView dead-end telemetry wiring", () => {
  beforeEach(() => {
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  it("reports an established absence once, however many times it re-renders", async () => {
    // The desktop-local source turns a `null` detail into a 404 (see
    // `local-agent-sessions-data-source.ts`), which is a genuine established
    // absence — `true_zero`, not the `unknown` a source that settled with
    // neither a row nor an error would report.
    const report = installDesktopApi(async () => null);
    const { rerender } = renderDetail(MISSING_SESSION_ID);

    await screen.findByText(NOT_FOUND_HEADING);
    await waitFor(() => expect(report).toHaveBeenCalled());

    expect(deadEndPayloads(report)).toEqual([
      {
        treatment: DeadEndFlowTreatment.SessionDetailNotFound,
        phase: DeadEndFlowPhase.Rendered,
        state: DeadEndFlowState.TrueZero,
        reason: DeadEndFlowReason.Absent,
        httpStatus: 404,
        retryOffered: false,
        retryAttempt: 0,
      },
    ]);

    // The same dead end, re-rendered. The detail polls, so this is not a
    // hypothetical commit — it is what the surface does on its own every few
    // seconds, and each one would be another counted "error" without the guard.
    rerender(
      withProviders(
        <SessionDetailView
          backHref="/sessions"
          sessionId={MISSING_SESSION_ID}
        />
      )
    );
    rerender(
      withProviders(
        <SessionDetailView
          backHref="/sessions"
          sessionId={MISSING_SESSION_ID}
        />
      )
    );

    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports a provider outage as unavailable, never as a missing session", async () => {
    // The failure a user cannot tell apart from the one above by looking at the
    // pane, and the one this telemetry has to keep separate: the session still
    // exists. The desktop-local source deliberately sanitizes every underlying
    // failure to a 500 rather than leak the db-host error, so 500 is the status
    // that genuinely reaches the renderer here — the cloud source is where an
    // upstream 401/403/5xx arrives verbatim.
    const report = installDesktopApi(() =>
      Promise.reject(new ApiError("gateway down", 503))
    );
    renderDetail(MISSING_SESSION_ID);

    await screen.findByText(UNAVAILABLE_HEADING);
    await waitFor(() => expect(report).toHaveBeenCalled());

    expect(deadEndPayloads(report).at(-1)).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionDetailUnavailable,
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      httpStatus: 500,
    });
  });

  it("puts no session id, name, or path on the wire", async () => {
    // The id is right there in the props and the failing read; a producer that
    // "helpfully" attached it would pass every other test in this file.
    const report = installDesktopApi(async () => null);
    renderDetail(MISSING_SESSION_ID);

    await screen.findByText(NOT_FOUND_HEADING);
    await waitFor(() => expect(report).toHaveBeenCalled());

    for (const payload of deadEndPayloads(report)) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(MISSING_SESSION_ID);
      expect(serialized).not.toMatch(PATH_SEPARATOR);
      // Only the closed-vocabulary keys, so a field added upstream cannot ride
      // along unnoticed.
      expect(Object.keys(payload).toSorted()).toEqual(
        [
          "httpStatus",
          "phase",
          "reason",
          "retryAttempt",
          "retryOffered",
          "state",
          "treatment",
        ].toSorted()
      );
    }
  });
});
