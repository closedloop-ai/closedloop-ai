/**
 * @description ISS-7249: the five no-data states must stay five things.
 *
 * These tests are written so that folding ANY two of them together fails —
 * `loading` onto `unavailable`, `unknown` onto `true_zero`, `not_applicable`
 * onto either. That is the whole defect the ticket names, so the assertions are
 * about the classifier's OUTPUT SET being five-valued and about each state
 * having a distinct producing branch, not about round-tripping one happy case.
 */

import { SessionDetailErrorKind } from "@repo/app/agents/components/detail/agent-session-detail-states";
import { describe, expect, it } from "vitest";
import {
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../../shared/dead-end-telemetry-contract";
import {
  resolveSessionDetailDeadEnd,
  resolveSessionsListDeadEnd,
  type SessionsListDeadEndInputs,
} from "../dead-end-cause";

const SERVING_LIST: SessionsListDeadEndInputs = {
  isTableLoading: false,
  hasRenderableData: true,
  hasLoadingLabel: false,
  stallPhase: "none",
  visibleRowCount: 25,
  emptySignals: { isUnavailable: false, hasActiveFilters: false },
  isSyncing: false,
  isPageOutOfRange: false,
  httpStatus: null,
};

const BLOCKING_LOAD: SessionsListDeadEndInputs = {
  ...SERVING_LIST,
  isTableLoading: true,
  hasRenderableData: false,
  visibleRowCount: 0,
};

const SETTLED_EMPTY: SessionsListDeadEndInputs = {
  ...SERVING_LIST,
  hasRenderableData: false,
  visibleRowCount: 0,
};

describe("resolveSessionsListDeadEnd", () => {
  it("reports nothing while the list is serving rows", () => {
    expect(resolveSessionsListDeadEnd(SERVING_LIST)).toBeNull();
  });

  it("reports nothing for the first seconds of a normal load", () => {
    // A spinner that has not run long enough to be a problem is the product
    // working. Counting it would bury every real dead end under page loads.
    expect(resolveSessionsListDeadEnd(BLOCKING_LOAD)).toBeNull();
  });

  it("reports nothing while a keep-previous refetch label is up", () => {
    // The body renders a plain spinner whatever else is true, so claiming a
    // treatment rendered here would be a claim about a screen nobody saw.
    expect(
      resolveSessionsListDeadEnd({
        ...SETTLED_EMPTY,
        hasLoadingLabel: true,
        emptySignals: { isUnavailable: true, hasActiveFilters: false },
      })
    ).toBeNull();
  });

  it("reports both stall phases as loading with no retry offered, never as a failure", () => {
    // ISS-11204 retired the soft/hard escalation: elapsed time is not a request
    // failure, so the list surface keeps the spinner at BOTH phases and renders
    // no Retry. The record has to say the same thing.
    //
    // This case used to assert the split, and both of its rows had gone wrong
    // in different ways — the soft row claimed a Retry that is no longer
    // rendered, and the hard row claimed the whole `SessionsListUnavailable`
    // treatment, which a stall can no longer produce at all. `retryOffered` is
    // asserted EXPLICITLY on each rather than dropped from the matcher: it is
    // the field the "dead end with no way out" rate is computed from, so a
    // regression to `true` has to redden here.
    const soft = resolveSessionsListDeadEnd({
      ...BLOCKING_LOAD,
      stallPhase: "soft",
    });
    const hard = resolveSessionsListDeadEnd({
      ...BLOCKING_LOAD,
      stallPhase: "hard",
    });

    for (const cause of [soft, hard]) {
      expect(cause).toMatchObject({
        treatment: DeadEndFlowTreatment.SessionsListStalled,
        state: DeadEndFlowState.Loading,
        reason: DeadEndFlowReason.LoadingThresholdExceeded,
        retryOffered: false,
      });
    }

    // The escalation is gone rather than merely relabelled: the two phases now
    // produce the SAME verdict, which is what reddens if a later change
    // re-introduces a distinction between them under any field.
    expect(hard).toEqual(soft);
    // And the retired treatment cannot come back through a stall.
    expect(hard?.treatment).not.toBe(
      DeadEndFlowTreatment.SessionsListUnavailable
    );
  });

  it("splits a source still coming up from a read that failed", () => {
    // Both render the same unavailable surface, and they are not the same
    // problem: one resolves itself, the other needs someone. This is the only
    // place either surface can honestly say `not_yet_synced`.
    const unavailable = {
      ...SETTLED_EMPTY,
      emptySignals: { isUnavailable: true, hasActiveFilters: false },
    };
    expect(
      resolveSessionsListDeadEnd({ ...unavailable, isSyncing: true })
    ).toMatchObject({
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.NotYetSynced,
      // review cid 3818119802: syncing renders `SyncingEmpty` — a title, a
      // clock icon, no action. Reporting a retry affordance here would make the
      // "dead end with no way out" rate undercount by exactly these.
      retryOffered: false,
    });
    expect(
      resolveSessionsListDeadEnd({ ...unavailable, isSyncing: false })
    ).toMatchObject({
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      // The failed read renders `ErroredEmpty`, which always carries an action
      // — the host's "Clear filters and reload" Link, or a lone Retry when none
      // is wired. A reload is a retry affordance, so this branch stays true.
      retryOffered: true,
    });
  });

  it("reports a permission refusal on the list the same way the detail does", () => {
    // whitlockk review: the list discarded the `ApiError` status and reported every
    // Cloud failure as `fetch_failed`, while the DETAIL classified the same
    // 401/403 as `permission_denied` and carried the status. One failure with
    // two vocabularies makes "how many dead ends are permission problems"
    // unanswerable, so the list now speaks the detail's words.
    const failedRead: SessionsListDeadEndInputs = {
      ...SETTLED_EMPTY,
      emptySignals: { isUnavailable: true, hasActiveFilters: false },
      isSyncing: false,
    };

    for (const httpStatus of [401, 403]) {
      const listCause = resolveSessionsListDeadEnd({
        ...failedRead,
        httpStatus,
      });
      const detailCause = resolveSessionDetailDeadEnd({
        errorKind: SessionDetailErrorKind.ProviderError,
        hasSession: false,
        httpStatus,
        isError: true,
        isLoading: false,
        stallPhase: "none",
      });
      expect(listCause).toMatchObject({
        state: DeadEndFlowState.Unavailable,
        reason: DeadEndFlowReason.PermissionDenied,
        httpStatus,
      });
      // The two surfaces must agree on the WHY and the status; only the
      // treatment and the way out legitimately differ.
      expect(listCause?.reason).toBe(detailCause?.reason);
      expect(listCause?.httpStatus).toBe(detailCause?.httpStatus);
    }

    // A non-permission answer still reports the generic failure, carrying the
    // status it did receive.
    expect(
      resolveSessionsListDeadEnd({ ...failedRead, httpStatus: 503 })
    ).toMatchObject({
      reason: DeadEndFlowReason.FetchFailed,
      httpStatus: 503,
    });
    // No response arrived: no status is invented for one.
    const noResponse = resolveSessionsListDeadEnd(failedRead);
    expect(noResponse).toMatchObject({ reason: DeadEndFlowReason.FetchFailed });
    expect(noResponse && "httpStatus" in noResponse).toBe(false);
  });

  it("never attaches a status to a source that is still syncing", () => {
    // A source coming up received no response, so a status there would describe
    // a server exchange that never happened.
    const syncing = resolveSessionsListDeadEnd({
      ...SETTLED_EMPTY,
      emptySignals: { isUnavailable: true, hasActiveFilters: false },
      httpStatus: 403,
      isSyncing: true,
    });

    expect(syncing).toMatchObject({ reason: DeadEndFlowReason.NotYetSynced });
    expect(syncing && "httpStatus" in syncing).toBe(false);
  });

  it("splits a filtered-away scope from a genuinely empty one", () => {
    expect(
      resolveSessionsListDeadEnd({
        ...SETTLED_EMPTY,
        emptySignals: { isUnavailable: false, hasActiveFilters: true },
      })
    ).toMatchObject({
      state: DeadEndFlowState.NotApplicable,
      reason: DeadEndFlowReason.FilteredOut,
    });
    expect(resolveSessionsListDeadEnd(SETTLED_EMPTY)).toMatchObject({
      state: DeadEndFlowState.TrueZero,
      reason: DeadEndFlowReason.Absent,
    });
  });

  it("says nothing while the page is past the end of the settled total", () => {
    // `deriveListEmptyReason` requires its hosts to clamp BEFORE classifying:
    // the blank frame is repaired on the next commit, but a `true_zero` record
    // would already be on the wire — filed as an established absence, which is
    // the one state a dead-end rate excludes.
    expect(
      resolveSessionsListDeadEnd({ ...SETTLED_EMPTY, isPageOutOfRange: true })
    ).toBeNull();
    // Positive control: the same inputs DO classify once the page is in range.
    expect(resolveSessionsListDeadEnd(SETTLED_EMPTY)).not.toBeNull();
  });

  it("never reclassifies a failed read as an empty scope", () => {
    // FEA-4181's precedence, restated as telemetry: an errored read tells us
    // nothing about whether the scope has rows, so it can never report
    // `true_zero` — the all-clear it has not earned.
    expect(
      resolveSessionsListDeadEnd({
        ...SETTLED_EMPTY,
        emptySignals: { isUnavailable: true, hasActiveFilters: true },
      })
    ).toMatchObject({ state: DeadEndFlowState.Unavailable });
  });
});

describe("resolveSessionDetailDeadEnd", () => {
  const LOADED = {
    isLoading: false,
    isError: false,
    hasSession: true,
    errorKind: undefined,
    httpStatus: null,
    stallPhase: "none" as const,
  };

  it("reports nothing for a loaded session", () => {
    expect(resolveSessionDetailDeadEnd(LOADED)).toBeNull();
  });

  it("reports nothing for a load that has not run long", () => {
    expect(
      resolveSessionDetailDeadEnd({
        ...LOADED,
        hasSession: false,
        isLoading: true,
      })
    ).toBeNull();
  });

  it("reports a stalled load as loading, not as a failure", () => {
    expect(
      resolveSessionDetailDeadEnd({
        ...LOADED,
        hasSession: false,
        isLoading: true,
        stallPhase: "soft",
      })
    ).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionDetailStalled,
      state: DeadEndFlowState.Loading,
      reason: DeadEndFlowReason.LoadingThresholdExceeded,
    });
  });

  it("splits an established 404 from a settled read that established nothing", () => {
    // BOTH render "Session not found". They are not the same fact: one is a
    // source that answered "no such session", the other is a read that came back
    // with neither a row nor an error. Reporting them as one number is exactly
    // the collapse ISS-7249 exists to undo, so the treatment matches and the
    // STATE does not.
    const notFound = resolveSessionDetailDeadEnd({
      ...LOADED,
      hasSession: false,
      isError: true,
      errorKind: SessionDetailErrorKind.NotPresent,
      httpStatus: 404,
    });
    const settledEmpty = resolveSessionDetailDeadEnd({
      ...LOADED,
      hasSession: false,
    });

    expect(notFound?.treatment).toBe(settledEmpty?.treatment);
    expect(notFound).toMatchObject({
      state: DeadEndFlowState.TrueZero,
      reason: DeadEndFlowReason.Absent,
      httpStatus: 404,
    });
    expect(settledEmpty).toMatchObject({
      state: DeadEndFlowState.Unknown,
      reason: DeadEndFlowReason.Unclassified,
    });
    expect(settledEmpty?.state).not.toBe(notFound?.state);
  });

  it("splits a permission refusal from a generic fetch failure", () => {
    for (const httpStatus of [401, 403]) {
      expect(
        resolveSessionDetailDeadEnd({
          ...LOADED,
          hasSession: false,
          isError: true,
          errorKind: SessionDetailErrorKind.ProviderError,
          httpStatus,
        })
      ).toMatchObject({
        state: DeadEndFlowState.Unavailable,
        reason: DeadEndFlowReason.PermissionDenied,
        httpStatus,
      });
    }
    expect(
      resolveSessionDetailDeadEnd({
        ...LOADED,
        hasSession: false,
        isError: true,
        errorKind: SessionDetailErrorKind.ProviderError,
        httpStatus: 500,
      })
    ).toMatchObject({
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      httpStatus: 500,
    });
  });

  it("omits the status entirely when no response carried one", () => {
    const cause = resolveSessionDetailDeadEnd({
      ...LOADED,
      hasSession: false,
      isError: true,
      errorKind: SessionDetailErrorKind.ProviderError,
      httpStatus: null,
    });

    expect(cause).toMatchObject({ reason: DeadEndFlowReason.FetchFailed });
    expect(cause && "httpStatus" in cause).toBe(false);
  });

  it("states that the detail offers no way out", () => {
    // Not a placeholder — a fact about the surface. "How often does a user hit a
    // dead end with no retry at all" is answerable only because it is said.
    expect(
      resolveSessionDetailDeadEnd({
        ...LOADED,
        hasSession: false,
        isError: true,
        errorKind: SessionDetailErrorKind.NotPresent,
        httpStatus: 404,
      })?.retryOffered
    ).toBe(false);
  });
});

describe("the five states across both Sessions surfaces", () => {
  it("are produced by five distinct branches, not folded into fewer", () => {
    const produced = [
      resolveSessionsListDeadEnd({ ...BLOCKING_LOAD, stallPhase: "soft" }),
      resolveSessionsListDeadEnd({
        ...SETTLED_EMPTY,
        emptySignals: { isUnavailable: true, hasActiveFilters: false },
      }),
      resolveSessionsListDeadEnd({
        ...SETTLED_EMPTY,
        emptySignals: { isUnavailable: false, hasActiveFilters: true },
      }),
      resolveSessionDetailDeadEnd({
        errorKind: undefined,
        hasSession: false,
        httpStatus: null,
        isError: false,
        isLoading: false,
        stallPhase: "none",
      }),
      resolveSessionsListDeadEnd(SETTLED_EMPTY),
    ].map((cause) => cause?.state);

    expect(produced).toEqual([
      DeadEndFlowState.Loading,
      DeadEndFlowState.Unavailable,
      DeadEndFlowState.NotApplicable,
      DeadEndFlowState.Unknown,
      DeadEndFlowState.TrueZero,
    ]);
    expect(new Set(produced).size).toBe(5);
  });
});
