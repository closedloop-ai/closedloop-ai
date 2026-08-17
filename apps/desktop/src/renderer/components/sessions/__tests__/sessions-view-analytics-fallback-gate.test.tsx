import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const sessionsViewHooks = sessionsViewHookMocks();

/**
 * ISS-5273: `syncSource.aggregateAnalytics` measured 27.1s (one call) on a real
 * 4,285-session corpus and straddled the first Sessions page turn — `paginate-1`
 * cost 26.8s against ~12.8s for the pages after it. On the Sessions surface that
 * read feeds ONE thing: the legacy Repository-facet fallback, which
 * `buildSessionsRenderModel` consumes only when usage is present and reports no
 * repositories (FEA-4299 made usage the facet owner).
 *
 * These assert the PRODUCTION WIRING of that gate — that SessionsView actually
 * declines to issue the read when the fallback is provably discarded, and still
 * issues it when the fallback is the only thing that can populate the facet.
 * The pure predicate itself is covered in `sessions-view-repository-facet`.
 */

/** A local-source probe that reports ready, so the read gates open. */
function readyLocalSourceProbe() {
  return vi.fn(() =>
    Promise.resolve({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    })
  );
}

/**
 * A settled page-data read holding rows, with the usage half carrying whatever
 * repository rollup the case is about. Rows + settled + ready are what open
 * `canFetchAuxiliaryData`, so each case isolates the repository dimension.
 */
function settledPageDataWithRepositories(
  byRepository: { repositoryFullName: string }[] | undefined
) {
  return {
    data: {
      list: listWith([{ id: "s1" }]),
      usage: byRepository === undefined ? undefined : { byRepository },
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

/** The `enabled` flag SessionsView passed on the most recent analytics call. */
function lastAnalyticsEnabled(): boolean | undefined {
  const lastCall = sessionsViewHooks.useAgentSessionAnalytics.mock.lastCall;
  return lastCall?.[1]?.enabled;
}

describe("SessionsView analytics Repository-fallback read gate (ISS-5273)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultSessionsViewHooks();
    installDesktopApiStub({
      getAgentMonitorUrl: readyLocalSourceProbe(),
      onDbChanged: vi.fn(() => undefined),
    });
  });

  afterEach(() => {
    cleanup();
    restoreDesktopApi();
  });

  it("issues no analytics read when usage already owns the Repository facet", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue(
      settledPageDataWithRepositories([
        { repositoryFullName: "closedloop-ai/symphony-alpha" },
      ])
    );

    await renderSessionsView();

    // Never enabled — not merely disabled by the last frame. A single enabled
    // frame during settling is a real 27s read on the user's machine.
    expect(sessionsViewHooks.useAgentSessionAnalytics).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
    expect(lastAnalyticsEnabled()).toBe(false);
  });

  it("still issues the analytics read when usage reports no repositories", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue(
      settledPageDataWithRepositories([])
    );

    await renderSessionsView();

    // The opposite arm of the case above: same settled/ready inputs, only the
    // repository rollup differs, so a gate that simply never enabled would fail
    // here. This is the state the fallback exists for — the facet has no options
    // without it, so it must not be deferred or dropped.
    expect(lastAnalyticsEnabled()).toBe(true);
  });

  it("issues no analytics read while the usage half is missing", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue(
      settledPageDataWithRepositories(undefined)
    );

    await renderSessionsView();

    // With no usage summary the render model drops the breakdown entirely, so a
    // read here could only ever be discarded.
    expect(lastAnalyticsEnabled()).toBe(false);
  });

  it("issues no analytics read before the list has settled, even with no repositories", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
      ...settledPageDataWithRepositories([]),
      isFetching: true,
      isPlaceholderData: true,
    });

    await renderSessionsView();

    // The pre-existing `canFetchAuxiliaryData` half of the gate still holds: the
    // new predicate narrows that gate, it does not widen it into an in-flight read.
    expect(lastAnalyticsEnabled()).toBe(false);
  });
});
