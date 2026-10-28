/**
 * @description ISS-7249's hardest acceptance criterion, pinned: a dead-end
 * treatment emits exactly once per render-WITH-CAUSE, not once per re-render.
 *
 * React re-renders freely, so a hook that reports from a naive effect turns one
 * dead end a user hit into a stream of records — a different wrong number from
 * the one this ticket set out to fix, but a wrong number all the same. The
 * `emittedKeyRef` comparison in the hook is the only thing standing between
 * those two outcomes, and these tests are what make deleting it go red.
 */
import { act, render } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DeadEndFlowPhase,
  DeadEndFlowReason,
  DeadEndFlowRetryOutcome,
  DeadEndFlowState,
  DeadEndFlowTreatment,
  type DeadEndTelemetryPayload,
} from "../../../shared/dead-end-telemetry-contract";
import {
  DesktopAppCoreMode,
  DesktopAppCoreModeContext,
} from "../../shared-agent-sessions/desktop-app-core-mode";
import {
  type DeadEndCause,
  type DeadEndTelemetry,
  useDeadEndTelemetry,
} from "../use-dead-end-telemetry";

const UNAVAILABLE_LIST: DeadEndCause = {
  treatment: DeadEndFlowTreatment.SessionsListUnavailable,
  state: DeadEndFlowState.Unavailable,
  reason: DeadEndFlowReason.FetchFailed,
  retryOffered: true,
};

const NOT_FOUND_DETAIL: DeadEndCause = {
  treatment: DeadEndFlowTreatment.SessionDetailNotFound,
  state: DeadEndFlowState.TrueZero,
  reason: DeadEndFlowReason.Absent,
  retryOffered: false,
  httpStatus: 404,
};

function Harness({
  active = true,
  cause,
  report,
  onReady,
}: {
  active?: boolean;
  cause: DeadEndCause | null;
  report: (payload: DeadEndTelemetryPayload) => void;
  onReady?: (telemetry: DeadEndTelemetry) => void;
}) {
  const telemetry = useDeadEndTelemetry({ active, cause, report });
  onReady?.(telemetry);
  // A counter the test can bump to force a re-render that changes NOTHING about
  // the dead end — the exact shape of a poll tick or an unrelated context update.
  const [, setTick] = useState(0);
  return (
    <button onClick={() => setTick((tick) => tick + 1)} type="button">
      rerender
    </button>
  );
}

function renderHarness(cause: DeadEndCause | null, initialActive = true) {
  const report = vi.fn<(payload: DeadEndTelemetryPayload) => void>();
  let telemetry: DeadEndTelemetry | null = null;
  const utils = render(
    <Harness
      active={initialActive}
      cause={cause}
      onReady={(value) => {
        telemetry = value;
      }}
      report={report}
    />
  );
  const rerenderWith = (next: DeadEndCause | null, active = true) =>
    utils.rerender(
      <Harness
        active={active}
        cause={next}
        onReady={(value) => {
          telemetry = value;
        }}
        report={report}
      />
    );
  return {
    report,
    rerenderWith,
    getTelemetry: () => {
      if (telemetry === null) {
        throw new Error("harness never rendered");
      }
      return telemetry;
    },
    unmount: utils.unmount,
    clickRerender: () => utils.getByRole("button").click(),
  };
}

describe("useDeadEndTelemetry render-with-cause deduplication", () => {
  it("emits once when a dead-end treatment first renders", () => {
    const { report } = renderHarness(UNAVAILABLE_LIST);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toEqual({
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
      phase: DeadEndFlowPhase.Rendered,
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      retryOffered: true,
      retryAttempt: 0,
    });
  });

  it("does not re-emit when the same dead end re-renders", () => {
    // THE regression. Every one of these is a commit that would produce another
    // record if the key guard were dropped: a parent re-render with a fresh
    // object, an internal state bump, and a repeat of both.
    const { report, rerenderWith, clickRerender } =
      renderHarness(UNAVAILABLE_LIST);
    expect(report).toHaveBeenCalledTimes(1);

    rerenderWith({ ...UNAVAILABLE_LIST });
    act(() => clickRerender());
    rerenderWith({ ...UNAVAILABLE_LIST });
    act(() => clickRerender());

    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not double-emit under StrictMode's replayed mount effect", () => {
    const report = vi.fn<(payload: DeadEndTelemetryPayload) => void>();
    render(
      <StrictMode>
        <Harness cause={UNAVAILABLE_LIST} report={report} />
      </StrictMode>
    );

    // StrictMode runs mount → cleanup → mount. The guard lives in a ref, which
    // survives that replay, so the second run sees the key it already emitted.
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("emits again when the cause genuinely changes", () => {
    const { report, rerenderWith } = renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    rerenderWith(NOT_FOUND_DETAIL);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionDetailNotFound,
      state: DeadEndFlowState.TrueZero,
      httpStatus: 404,
    });
  });

  it("treats a changed status on the same treatment as a new dead end", () => {
    // A 404 that becomes a 503 is a different failure with a different fix, so
    // the key has to move even though the treatment name did not.
    const { report, rerenderWith } = renderHarness({
      ...NOT_FOUND_DETAIL,
      httpStatus: 404,
    });
    report.mockClear();

    rerenderWith({ ...NOT_FOUND_DETAIL, httpStatus: 503 });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ httpStatus: 503 });
  });

  it("emits nothing at all while the surface is serving normally", () => {
    const { report, rerenderWith, clickRerender } = renderHarness(null);

    rerenderWith(null);
    act(() => clickRerender());

    expect(report).not.toHaveBeenCalled();
  });

  it("re-emits a recurrence of the same dead end after the surface recovered", () => {
    // Not a duplicate: the user hit the dead end, got out, and hit it again.
    // That is two dead ends, and a guard that never cleared would count one.
    const { report, rerenderWith } = renderHarness(UNAVAILABLE_LIST);
    rerenderWith(null);
    report.mockClear();

    rerenderWith(UNAVAILABLE_LIST);

    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("useDeadEndTelemetry retry attempt and outcome", () => {
  it("records the attempt and then the recovery it produced", async () => {
    const { report, rerenderWith, getTelemetry } =
      renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    await act(async () => {
      // The retry's own read is what clears the dead end, so the harness moves
      // the cause to null from inside it — the production shape, where
      // `refetch()` resolving is what makes the next commit render rows.
      await getTelemetry().trackRetry(async () => {
        rerenderWith(null);
        await Promise.resolve();
      });
    });

    const phases = report.mock.calls.map((call) => [
      call[0].phase,
      call[0].retryOutcome,
      call[0].retryAttempt,
    ]);
    expect(phases).toEqual([
      [DeadEndFlowPhase.RetryAttempted, undefined, 1],
      [DeadEndFlowPhase.RetrySettled, DeadEndFlowRetryOutcome.Recovered, 1],
    ]);
    // The recovered record still names WHAT it recovered from — otherwise "do
    // retries of this treatment work" is unanswerable.
    const settled = report.mock.calls.at(-1)?.[0];
    expect(settled).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
    });
  });

  it("records a retry that landed on the very same dead end", async () => {
    // The case a naive key-equality guard swallows, and the one the ticket cares
    // most about: the affordance ran and changed nothing.
    const { report, getTelemetry } = renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    await act(async () => {
      await getTelemetry().trackRetry(() => Promise.resolve());
    });

    expect(
      report.mock.calls.map((call) => [call[0].phase, call[0].retryOutcome])
    ).toEqual([
      [DeadEndFlowPhase.RetryAttempted, undefined],
      [DeadEndFlowPhase.RetrySettled, DeadEndFlowRetryOutcome.StillDeadEnd],
    ]);
  });

  it("carries the new failure when a retry turns one dead end into another", async () => {
    const { report, rerenderWith, getTelemetry } =
      renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    await act(async () => {
      await getTelemetry().trackRetry(async () => {
        rerenderWith(NOT_FOUND_DETAIL);
        await Promise.resolve();
      });
    });

    const settled = report.mock.calls.find(
      (call) => call[0].phase === DeadEndFlowPhase.RetrySettled
    )?.[0];
    expect(settled).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionDetailNotFound,
      state: DeadEndFlowState.TrueZero,
      retryOutcome: DeadEndFlowRetryOutcome.StillDeadEnd,
    });
  });

  it("keeps the settled record's attempt count agreeing with its attempted sibling across a mid-retry cause gap", async () => {
    /*
     * The production shape on the Sessions list, and the reason the in-flight
     * guard exists: pressing Retry bumps the stall detector's reset token, so
     * `useLoadingStall` drops the phase back to `none` on the very next commit
     * and the classifier — correctly — stops calling a sub-threshold load a dead
     * end. Read as a recovery, that zeroed the tally, so `retry_settled` shipped
     * `retryAttempt: 0` beside a `retry_attempted` that said 1, and cleared the
     * emitted key so the same stall re-counted itself when the timers re-fired.
     *
     * The read is a DEFERRED promise the test resolves by hand, because the gap
     * has to be real committed renders BETWEEN the attempt and the settle — a
     * rerender called inside the attempt callback is flushed at the end of the
     * enclosing `act`, after the settle, and never exercises the gap at all.
     */
    const { report, rerenderWith, getTelemetry } =
      renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    let answerRead: () => void = () => undefined;
    const read = new Promise<void>((resolve) => {
      answerRead = resolve;
    });
    let tracked: Promise<void> = Promise.resolve();
    act(() => {
      tracked = getTelemetry().trackRetry(() => read);
    });
    expect(report.mock.calls.map((call) => call[0].phase)).toEqual([
      DeadEndFlowPhase.RetryAttempted,
    ]);
    expect(report.mock.calls[0]?.[0].retryAttempt).toBe(1);

    // The gap: the stall detector re-arms, then escalates again — real commits,
    // with the read still outstanding.
    act(() => rerenderWith(null));
    act(() => rerenderWith(UNAVAILABLE_LIST));
    // Nothing new was counted: the user never left the dead end they retried.
    expect(report).toHaveBeenCalledTimes(1);

    await act(async () => {
      answerRead();
      await tracked;
    });

    const attempted = report.mock.calls.find(
      (call) => call[0].phase === DeadEndFlowPhase.RetryAttempted
    )?.[0];
    const settled = report.mock.calls.find(
      (call) => call[0].phase === DeadEndFlowPhase.RetrySettled
    )?.[0];
    expect(settled?.retryAttempt).toBe(attempted?.retryAttempt);
    expect(settled?.retryAttempt).toBe(1);
    expect(settled?.retryOutcome).toBe(DeadEndFlowRetryOutcome.StillDeadEnd);
  });

  it("does not report a recovery just because the stall detector re-armed", async () => {
    // The other half of the same gap: a mid-retry null cause must not be read as
    // "it worked". The outcome is resolved when the READ answers, not on
    // whichever commit happens to have no treatment on screen.
    const { report, rerenderWith, getTelemetry } =
      renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    let answerRead: () => void = () => undefined;
    const read = new Promise<void>((resolve) => {
      answerRead = resolve;
    });
    let tracked: Promise<void> = Promise.resolve();
    act(() => {
      tracked = getTelemetry().trackRetry(() => read);
    });
    act(() => rerenderWith(null));

    await act(async () => {
      answerRead();
      await tracked;
    });

    // The surface really is clear when the read answers, so this one IS a
    // recovery — and it still names what it recovered from.
    expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: DeadEndFlowPhase.RetrySettled,
      retryOutcome: DeadEndFlowRetryOutcome.Recovered,
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
      retryAttempt: 1,
    });
  });

  it("keeps one outstanding retry's bookkeeping intact when the user presses Retry again", async () => {
    /*
     * review cids 3821324867 / 3821325376. The Sessions list's Retry carries no
     * disabled or pending state, so a second press while the first read is
     * outstanding is an ordinary user action, not an edge case. Unguarded it
     * corrupted two things at once: the single `retrySettledPendingRef` slot was
     * overwritten before React flushed, so two `retry_attempted` records shipped
     * against ONE `retry_settled` — which the contract reads as a retry that
     * never came back — and press 1's completion nulled `retryInFlightRef` while
     * press 2 was still outstanding, re-opening the mid-retry cause gap the
     * sibling test above exists to close.
     *
     * Both reads are deferred so the overlap is real: press 2 is issued while
     * press 1's promise is genuinely unsettled.
     */
    const { report, rerenderWith, getTelemetry } =
      renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    let answerFirst: () => void = () => undefined;
    const firstRead = new Promise<void>((resolve) => {
      answerFirst = resolve;
    });
    let answerSecond: () => void = () => undefined;
    const secondRead = new Promise<void>((resolve) => {
      answerSecond = resolve;
    });
    const secondAttempt = vi.fn(() => secondRead);

    let firstTracked: Promise<void> = Promise.resolve();
    act(() => {
      firstTracked = getTelemetry().trackRetry(() => firstRead);
    });
    let secondTracked: Promise<void> = Promise.resolve();
    act(() => {
      secondTracked = getTelemetry().trackRetry(secondAttempt);
    });

    // The duplicate press still runs the real recovery — telemetry must never
    // swallow the behavior it observes.
    expect(secondAttempt).toHaveBeenCalledTimes(1);
    // ...but it is not a second tracked attempt.
    expect(report.mock.calls.map((call) => call[0].phase)).toEqual([
      DeadEndFlowPhase.RetryAttempted,
    ]);
    expect(report.mock.calls[0]?.[0].retryAttempt).toBe(1);

    await act(async () => {
      answerFirst();
      answerSecond();
      await Promise.all([firstTracked, secondTracked]);
    });

    // The mid-retry gap stays closed for the WHOLE overlap: exactly one settle,
    // agreeing with the one attempt, and no re-counted render record.
    const phases = report.mock.calls.map((call) => call[0].phase);
    expect(phases).toEqual([
      DeadEndFlowPhase.RetryAttempted,
      DeadEndFlowPhase.RetrySettled,
    ]);
    const settled = report.mock.calls.at(-1)?.[0];
    expect(settled?.retryAttempt).toBe(1);
    expect(settled?.retryOutcome).toBe(DeadEndFlowRetryOutcome.StillDeadEnd);

    // The tally still belongs to the outstanding retry, so the NEXT genuine
    // press is attempt 2 — not 1 (reset by a leaked gap) and not 3 (inflated by
    // the duplicate).
    report.mockClear();
    act(() => rerenderWith(UNAVAILABLE_LIST));
    await act(async () => {
      await getTelemetry().trackRetry(() => Promise.resolve());
    });
    expect(
      report.mock.calls.find(
        (call) => call[0].phase === DeadEndFlowPhase.RetryAttempted
      )?.[0].retryAttempt
    ).toBe(2);
  });

  it("counts retries since the surface last worked, resetting on recovery", async () => {
    const { report, rerenderWith, getTelemetry } =
      renderHarness(UNAVAILABLE_LIST);

    await act(async () => {
      await getTelemetry().trackRetry(() => Promise.resolve());
    });
    await act(async () => {
      await getTelemetry().trackRetry(() => Promise.resolve());
    });
    expect(
      report.mock.calls
        .filter((call) => call[0].phase === DeadEndFlowPhase.RetryAttempted)
        .map((call) => call[0].retryAttempt)
    ).toEqual([1, 2]);

    rerenderWith(null);
    rerenderWith(UNAVAILABLE_LIST);
    report.mockClear();
    await act(async () => {
      await getTelemetry().trackRetry(() => Promise.resolve());
    });

    expect(report.mock.calls[0]?.[0].retryAttempt).toBe(1);
  });

  it("still runs the retry, but counts nothing, when no dead end is on screen", async () => {
    // A conditional tally must increment only inside the branch where its
    // precondition held. A press against a working surface recovers nothing
    // because there was nothing to recover, and counting it inflates the rate.
    const { report, getTelemetry } = renderHarness(null);
    const attempt = vi.fn(() => Promise.resolve());

    await act(async () => {
      await getTelemetry().trackRetry(attempt);
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("says nothing about an outcome nobody was on screen for", async () => {
    const { report, getTelemetry, unmount } = renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    await act(async () => {
      await getTelemetry().trackRetry(async () => {
        unmount();
        await Promise.resolve();
      });
    });

    // The attempt is a fact and ships; the outcome would be a guess about a
    // screen that no longer exists, so it does not.
    expect(report.mock.calls.map((call) => call[0].phase)).toEqual([
      DeadEndFlowPhase.RetryAttempted,
    ]);
  });

  it("does not swallow a rejected retry into an unhandled rejection", async () => {
    const { report, getTelemetry } = renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    await act(async () => {
      await getTelemetry().trackRetry(() => Promise.reject(new Error("boom")));
    });

    // A failed read is still a settled retry, and the surface is still a dead
    // end — that is the honest outcome, not a dropped record.
    expect(report.mock.calls.map((call) => call[0].phase)).toEqual([
      DeadEndFlowPhase.RetryAttempted,
      DeadEndFlowPhase.RetrySettled,
    ]);
  });
});

describe("useDeadEndTelemetry keep-alive page gating", () => {
  it("says nothing about a dead end reached while the page is hidden", () => {
    // whitlockk review: the desktop shell keeps every visited page mounted, so a
    // hidden Sessions tree keeps polling and can fail with nobody looking.
    const { report } = renderHarness(UNAVAILABLE_LIST, false);

    expect(report).not.toHaveBeenCalled();
  });

  it("emits the occurrence the user actually sees when the page comes back", () => {
    /*
     * This is the whole reason the gate exists, and why a duplicate would have
     * been the LESSER bug. Emitting from the background sets the emitted key, so
     * the identical treatment on the user's return is deduplicated away — the
     * one occurrence a person actually hit becomes the one never counted.
     */
    const { report, rerenderWith } = renderHarness(UNAVAILABLE_LIST, false);
    expect(report).not.toHaveBeenCalled();

    rerenderWith(UNAVAILABLE_LIST, true);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
      phase: DeadEndFlowPhase.Rendered,
      reason: DeadEndFlowReason.FetchFailed,
    });
  });

  it("still emits normally while the page is the visible content", () => {
    // Positive control: the gate must not be a switch that silences the surface.
    const { report, rerenderWith } = renderHarness(null, true);
    expect(report).not.toHaveBeenCalled();

    rerenderWith(UNAVAILABLE_LIST, true);

    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not withhold a retry outcome from a user who navigated away mid-read", async () => {
    // The settle is NOT gated: the attempt was real and already reported, so
    // dropping its outcome would strand it with no settled sibling — read by
    // the contract as a retry that never came back.
    const { report, getTelemetry, rerenderWith } =
      renderHarness(UNAVAILABLE_LIST);
    report.mockClear();

    await act(async () => {
      const settled = getTelemetry().trackRetry(() => Promise.resolve());
      rerenderWith(UNAVAILABLE_LIST, false);
      await settled;
    });

    expect(report.mock.calls.map((call) => call[0].phase)).toEqual([
      DeadEndFlowPhase.RetryAttempted,
      DeadEndFlowPhase.RetrySettled,
    ]);
  });
});

describe("useDeadEndTelemetry app-core mode (ISS-12039)", () => {
  it("marks a dead end rendered in Cloud mode", () => {
    const report = vi.fn<(payload: DeadEndTelemetryPayload) => void>();
    render(
      <DesktopAppCoreModeContext.Provider value={DesktopAppCoreMode.Cloud}>
        <Harness cause={UNAVAILABLE_LIST} report={report} />
      </DesktopAppCoreModeContext.Provider>
    );

    expect(report.mock.calls[0]?.[0]).toMatchObject({
      phase: DeadEndFlowPhase.Rendered,
      readsCloud: true,
    });
  });

  it("leaves a Local-mode dead end unmarked", () => {
    const report = vi.fn<(payload: DeadEndTelemetryPayload) => void>();
    render(
      <DesktopAppCoreModeContext.Provider value={DesktopAppCoreMode.Local}>
        <Harness cause={UNAVAILABLE_LIST} report={report} />
      </DesktopAppCoreModeContext.Provider>
    );

    expect(report.mock.calls[0]?.[0]).not.toHaveProperty("readsCloud");
  });
});
