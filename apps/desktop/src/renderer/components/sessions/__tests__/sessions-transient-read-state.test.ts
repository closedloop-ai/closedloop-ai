import { describe, expect, it } from "vitest";
import {
  emptySharedAgentSessionsListResponse,
  SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE,
} from "../../../../shared/shared-agent-sessions-contract";
import { TransientSourceError } from "../../../shared/transient-source-error";
import {
  classifyListReadErrorState,
  readUsageErrorFlags,
} from "../sessions-transient-read-state";

/**
 * ISS-4483: the pure classification behind SessionsView's transient-read routing.
 * Both halves of the combined (list + usage) read can fail transiently (the local
 * db-host child restarting mid-backfill); a transient failure must hold the quiet
 * reconnecting surface (cards skeleton, never dash) WHILE recovery is in flight,
 * and only fall through to the fatal `metricReadErrored` once recovery is
 * exhausted. A genuine failure is fatal immediately.
 */
describe("classifyListReadErrorState (ISS-4483)", () => {
  const transientListError = new TransientSourceError(
    "Agent sessions source failed.",
    SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
  );

  it("holds a transient LIST error (not errored) while retries remain", () => {
    const state = classifyListReadErrorState({
      isListError: true,
      listError: transientListError,
      usageError: false,
      hasSummaryUsage: false,
      transientRetriesExhausted: false,
    });
    expect(state.isListErrorTransient).toBe(true);
    expect(state.metricReadErrored).toBe(false);
    expect(state.transientReadWithoutUsage).toBe(true);
  });

  it("falls a transient LIST error through to fatal once retries are exhausted", () => {
    const state = classifyListReadErrorState({
      isListError: true,
      listError: transientListError,
      usageError: false,
      hasSummaryUsage: false,
      transientRetriesExhausted: true,
    });
    expect(state.isListErrorTransient).toBe(false);
    expect(state.metricReadErrored).toBe(true);
  });

  // review cid 3679616168, wongk: the usage-half transient path.
  it("holds a transient USAGE error (not errored) while recovery remains", () => {
    const state = classifyListReadErrorState({
      isListError: false,
      listError: null,
      usageError: true,
      usageErrorTransient: true,
      hasSummaryUsage: false,
      usageRecoveryExhausted: false,
    });
    expect(state.isUsageErrorTransient).toBe(true);
    expect(state.metricReadErrored).toBe(false);
    expect(state.transientReadWithoutUsage).toBe(true);
  });

  it("falls a transient USAGE error through to fatal once recovery is exhausted", () => {
    const state = classifyListReadErrorState({
      isListError: false,
      listError: null,
      usageError: true,
      usageErrorTransient: true,
      hasSummaryUsage: false,
      usageRecoveryExhausted: true,
    });
    expect(state.isUsageErrorTransient).toBe(false);
    expect(state.metricReadErrored).toBe(true);
  });

  it("treats a genuine (non-transient) usage failure as fatal immediately", () => {
    const state = classifyListReadErrorState({
      isListError: false,
      listError: null,
      usageError: true,
      usageErrorTransient: false,
      hasSummaryUsage: false,
    });
    expect(state.isUsageErrorTransient).toBe(false);
    expect(state.metricReadErrored).toBe(true);
    expect(state.transientReadWithoutUsage).toBe(false);
  });

  it("keeps rendering last-good usage during a transient recover (no skeleton)", () => {
    const state = classifyListReadErrorState({
      isListError: false,
      listError: null,
      usageError: true,
      usageErrorTransient: true,
      hasSummaryUsage: true,
      usageRecoveryExhausted: false,
    });
    expect(state.isUsageErrorTransient).toBe(true);
    expect(state.transientReadWithoutUsage).toBe(false);
  });
});

describe("readUsageErrorFlags (ISS-4483)", () => {
  it("reads no error and no usage from undefined page data", () => {
    expect(readUsageErrorFlags(undefined)).toEqual({
      usageError: false,
      usageErrorTransient: false,
      hasSummaryUsage: false,
    });
  });

  it("surfaces the transient usage marker off the resolved combined read", () => {
    expect(
      readUsageErrorFlags({
        list: emptySharedAgentSessionsListResponse(),
        usageError: true,
        usageErrorTransient: true,
      })
    ).toEqual({
      usageError: true,
      usageErrorTransient: true,
      hasSummaryUsage: false,
    });
  });
});
