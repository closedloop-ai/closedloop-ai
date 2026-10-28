import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { describe, expect, it } from "vitest";
import {
  hasActiveSessionRow,
  resolveSessionsActiveRefetchInterval,
  SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS,
  SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS,
  SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS,
} from "../sessions-active-refetch";

/**
 * FEA-4203 — the gate that decides whether the Sessions list polls.
 *
 * The regression each case protects is named on the case. What they have in
 * common is the failure this gate exists to prevent: an interval that runs on a
 * list with nothing moving on it. Every "no poll" case here is a `false` a
 * broken gate would return a number for, and `false` is the only value that
 * schedules nothing — a large interval is still a timer.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");

/** A run that is genuinely in flight: active, and it spoke a minute ago. */
function runningRow() {
  return createAgentSessionListItemFixture({
    awaitingInputSince: null,
    endedAt: null,
    id: "running",
    lastActivityAt: new Date("2026-08-24T11:59:00.000Z"),
    startedAt: new Date("2026-08-24T11:00:00.000Z"),
    status: SESSION_STATUS.ACTIVE,
  });
}

/** A finished run — the ordinary majority of any list. */
function terminalRow() {
  return createAgentSessionListItemFixture({
    awaitingInputSince: null,
    endedAt: new Date("2026-08-24T10:00:00.000Z"),
    id: "terminal",
    lastActivityAt: new Date("2026-08-24T10:00:00.000Z"),
    startedAt: new Date("2026-08-24T09:00:00.000Z"),
    status: SESSION_STATUS.INACTIVE,
  });
}

/**
 * Stored `active`, silent for two days.
 *
 * ISS-10364 (operator ruling, 2026-09-23): the displayed status no longer
 * folds this to Stale — the staleness fold that used to close the poll for
 * this row is retired, so it reads Active like any other stored-active row and
 * the poll now holds open for it too. See the two counterfactual assertions
 * below.
 */
function staleRow() {
  return createAgentSessionListItemFixture({
    awaitingInputSince: null,
    endedAt: null,
    id: "stale",
    lastActivityAt: new Date("2026-08-22T12:00:00.000Z"),
    startedAt: new Date("2026-08-22T11:00:00.000Z"),
    status: SESSION_STATUS.ACTIVE,
  });
}

/**
 * Stored `active` and recently noisy — identical to {@link runningRow} in every
 * field but one — except that it is awaiting human input, which the displayed
 * fold projects to Waiting.
 *
 * The pair is the point (PR review, review-soul). Waiting is live in the
 * lifecycle sense, so the gate's narrowing to ACTIVE is a real decision rather
 * than a spelling, and two mutations survive every other fixture in this file:
 * dropping the `awaitingInputSince` passthrough, and widening the comparison to
 * `ACTIVE || WAITING` — the exact shape the neighbouring `projectLiveWaiting`
 * uses to define "live", so it is the likely next edit. Both make this row poll.
 */
function waitingRow() {
  return createAgentSessionListItemFixture({
    awaitingInputSince: new Date("2026-08-24T11:30:00.000Z"),
    endedAt: null,
    id: "waiting",
    lastActivityAt: new Date("2026-08-24T11:59:00.000Z"),
    startedAt: new Date("2026-08-24T11:00:00.000Z"),
    status: SESSION_STATUS.ACTIVE,
  });
}

describe("hasActiveSessionRow", () => {
  it("finds a running row among terminal ones", () => {
    expect(hasActiveSessionRow([terminalRow(), runningRow()], NOW)).toBe(true);
  });

  it("is false for a page of terminal rows", () => {
    expect(hasActiveSessionRow([terminalRow(), terminalRow()], NOW)).toBe(
      false
    );
  });

  it("ISS-10364: is true for a stored-active row that has gone stale — the staleness fold that used to exclude it is retired", () => {
    // Counterfactual, and a real cost of the ruling: a long-silent row that was
    // never explicitly ended now reads Active forever, so it holds this gate
    // open too. Kept so a future re-narrowing has to edit this assertion.
    expect(hasActiveSessionRow([staleRow()], NOW)).toBe(true);
  });

  it("is false for a row awaiting human input", () => {
    expect(hasActiveSessionRow([waitingRow()], NOW)).toBe(false);
  });

  it("is false for an absent page", () => {
    expect(hasActiveSessionRow(undefined, NOW)).toBe(false);
    expect(hasActiveSessionRow([], NOW)).toBe(false);
  });
});

describe("resolveSessionsActiveRefetchInterval", () => {
  it("polls while a running row is on the page", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [terminalRow(), runningRow()],
        now: NOW,
      })
    ).toBe(30_000);
  });

  // The ACTIVE gate, both directions, off ONE fixture set: an implementation
  // that polled unconditionally passes the case above and fails this one.
  it("does not poll when no row is running", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [terminalRow(), terminalRow()],
        now: NOW,
      })
    ).toBe(false);
  });

  // Both directions off ONE pair: the two rows differ only in
  // `awaitingInputSince`, so a gate that dropped that field — or widened to
  // ACTIVE || WAITING — polls for both and fails the first of these.
  it("does not poll for a row awaiting human input", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [waitingRow()],
        now: NOW,
      })
    ).toBe(false);
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [runningRow()],
        now: NOW,
      })
    ).toBe(30_000);
  });

  it("ISS-10364: polls for a stale row — a real cost of the ruling, since a long-silent run now polls until the tab closes", () => {
    // Counterfactual: this used to be where the timer terminated itself once a
    // stored-active row went quiet past the cutoff. That cutoff is retired, so
    // a session whose agent died with the row left `active` now holds this
    // 30s poll open indefinitely rather than for a bounded 24h. Kept so a
    // future re-narrowing has to edit this assertion.
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [staleRow()],
        now: NOW,
      })
    ).toBe(30_000);
  });

  // The closed-by-default half. A flag-off build must schedule nothing even on
  // the exact input that would otherwise poll.
  it("does not poll with the flag off, even with a running row", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: false,
        items: [runningRow()],
        now: NOW,
      })
    ).toBe(false);
  });

  // The published cadence is the contract the wiring reads; pinned as a literal
  // so a silent retune of the constant fails here rather than in production.
  it("publishes a 30-second cadence", () => {
    expect(SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS).toBe(30_000);
  });

  // ISS-12286 — operator ruling (Marisol Ashgrove, 2026-10-08, PRD-792 open
  // question 1): the summary's fallback is two minutes.
  it("publishes a 2-minute summary fallback cadence", () => {
    expect(SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS).toBe(120_000);
  });

  // A caller's cadence replaces the healthy 30s only; the row gate, the flag,
  // and the error backoff still apply.
  it("uses the caller's cadence for a healthy read and keeps the gates", () => {
    const base = {
      enabled: true,
      intervalMs: SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS,
      now: NOW,
    };
    expect(
      resolveSessionsActiveRefetchInterval({
        ...base,
        items: [runningRow()],
        status: "success",
      })
    ).toBe(SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS);
    expect(
      resolveSessionsActiveRefetchInterval({
        ...base,
        items: [runningRow()],
        status: "error",
      })
    ).toBe(SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS);
    expect(
      resolveSessionsActiveRefetchInterval({
        ...base,
        items: [terminalRow()],
        status: "success",
      })
    ).toBe(false);
    expect(
      resolveSessionsActiveRefetchInterval({
        ...base,
        enabled: false,
        items: [runningRow()],
        status: "success",
      })
    ).toBe(false);
  });

  // packages/app/AGENTS.md: a polling hook must "stop or deliberately back off when
  // `query.state.status === 'error'`". Pinned to the BACK-OFF value, which fails
  // in both directions a future edit could take it: leaving the error case out
  // altogether returns the healthy 30s, and taking the STOP arm returns `false`.
  // The second is the one that matters — stopping strands a page the reader is
  // never told went stale (the page's error card is gated on `isLoadingError`).
  it("backs off, and does not stop, once the read is failing", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [runningRow()],
        now: NOW,
        status: "error",
      })
    ).toBe(SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS);
    // Same fixture, healthy read: an implementation that returned the backoff
    // unconditionally would pass the assertion above and fail this one.
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [runningRow()],
        now: NOW,
        status: "success",
      })
    ).toBe(SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS);
  });

  // The row gate is read FIRST: a failing read with nothing running schedules
  // nothing, rather than a backed-off timer on a page with no reason to poll.
  it("schedules nothing for a failing read with no running row", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: true,
        items: [terminalRow()],
        now: NOW,
        status: "error",
      })
    ).toBe(false);
  });

  // The flag still wins over everything, error included.
  it("does not poll with the flag off, even on a failing read", () => {
    expect(
      resolveSessionsActiveRefetchInterval({
        enabled: false,
        items: [runningRow()],
        now: NOW,
        status: "error",
      })
    ).toBe(false);
  });

  // A backoff that is not actually slower than the healthy cadence would satisfy
  // every assertion above while backing off nothing.
  it("publishes a backoff strictly slower than the healthy cadence", () => {
    expect(SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS).toBe(300_000);
    expect(SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS).toBeGreaterThan(
      SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS
    );
  });
});
