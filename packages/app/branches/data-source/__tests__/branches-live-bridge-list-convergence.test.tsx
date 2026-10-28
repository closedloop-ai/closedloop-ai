import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { useBranchesPageData } from "../../hooks/use-branches";
import type {
  BranchesChange,
  BranchesDataSource,
} from "../branches-data-source";
import {
  BranchesLiveBridge,
  INVALIDATION_THROTTLE_MS,
} from "../branches-live-bridge";
import { BranchesDataSourceProvider } from "../provider";
import { makeBranchRow } from "./branch-row-test-fixture";

/**
 * ISS-9553 — the branch list read must converge after a sync when it is
 * mounted under a live source.
 *
 * The bridge's hand-maintained prefix list omitted `branchesKeys.lists()`. This
 * is a LATENT gap rather than a live one: that key's only reader is the split
 * path of `useBranchesPageData`, which today only the poll-only HTTP source
 * takes, and this bridge does not drive it. So this suite pins the contract for
 * the first live source to take the split path — it does not reproduce a bug a
 * user can currently see.
 *
 * It asserts on the RENDERED rows rather than a refetch count: a count proves a
 * request went out, while the failure mode is a reader looking at pre-sync rows
 * in a view that reports itself settled.
 */

let hiddenValue = false;
let originalHiddenDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  hiddenValue = false;
  originalHiddenDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "hidden"
  );
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hiddenValue,
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHiddenDescriptor) {
    Object.defineProperty(document, "hidden", originalHiddenDescriptor);
  } else {
    // biome-ignore lint/performance/noDelete: restore jsdom's prototype getter
    delete (document as { hidden?: boolean }).hidden;
  }
});

const STALE_BRANCH_NAME = "pre-sync-branch";
const FRESH_BRANCH_NAME = "post-sync-branch";

type ObservedQuery = {
  status: string;
  branchNames: readonly string[];
};

/**
 * The canonical Branch row used by every data-source test, so this file asserts
 * against the shipped `BranchRow` shape rather than a local approximation of it.
 */
function branchRow(name: string) {
  return makeBranchRow(name);
}

/**
 * A source whose list read answers with the stale row first and the fresh row on
 * every later call, so a converged cache is observable as a CHANGE IN CONTENT.
 */
function listFakeSource(options: { failAfterFirst?: boolean } = {}) {
  let cb: ((change: BranchesChange) => void) | null = null;
  let calls = 0;
  const source: BranchesDataSource = {
    scope: "local",
    supportsSplitPageData: true,
    list: () => {
      calls += 1;
      if (options.failAfterFirst && calls > 1) {
        return Promise.reject(new Error("branch list refetch failed"));
      }
      const name = calls === 1 ? STALE_BRANCH_NAME : FRESH_BRANCH_NAME;
      return Promise.resolve({
        items: [branchRow(name)],
        total: 1,
        viewerScope: "self" as const,
      });
    },
    detail: () => Promise.reject(new Error("unused")),
    comments: () => Promise.reject(new Error("unused")),
    trace: () => Promise.reject(new Error("unused")),
    usage: () => Promise.reject(new Error("unused")),
    analytics: () => Promise.reject(new Error("unused")),
    cohortAnalytics: () => Promise.reject(new Error("unused")),
    pageData: () => Promise.reject(new Error("unused")),
    subscribe: (onChange: (change: BranchesChange) => void) => {
      cb = onChange;
      return () => {
        cb = null;
      };
    },
  };
  return {
    source,
    emit: (change: BranchesChange = {}) => cb?.(change),
    listCalls: () => calls,
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderListBridge(source: BranchesDataSource) {
  const observed: ObservedQuery = { status: "idle", branchNames: [] };

  function ListProbe() {
    // `retry: false` keeps the failure case deterministic — a retried read would
    // sit in `pending` past the window this test advances.
    const query = useBranchesPageData({ owner: "alice" }, { retry: false });
    observed.status = queryStatus(query);
    observed.branchNames = (query.data?.list.items ?? []).map(
      (item) => item.branchName
    );
    return null;
  }

  render(
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider
        dataSource={source}
        // `staleTime: Infinity` is load-bearing: it removes staleness as an
        // explanation, so any refetch here can only have come from the bridge's
        // invalidation.
        queryPolicy={{ staleTime: Number.POSITIVE_INFINITY }}
      >
        <BranchesLiveBridge />
        <ListProbe />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );

  return observed;
}

describe("BranchesLiveBridge standalone list convergence", () => {
  it("replaces stale rows with post-sync rows after a change event", async () => {
    const fake = listFakeSource();
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    // Positive baseline: the reader really is looking at the stale row, so the
    // assertion below cannot pass on a cache that simply never populated.
    expect(observed.branchNames).toEqual([STALE_BRANCH_NAME]);
    expect(observed.status).toBe("success");

    fake.emit({ branchId: "repo%2Fowner::main" });
    await advance(INVALIDATION_THROTTLE_MS);

    expect(observed.branchNames).toEqual([FRESH_BRANCH_NAME]);
    expect(observed.status).toBe("success");
  });

  it("converges on a broad change with no entity id", async () => {
    const fake = listFakeSource();
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(observed.branchNames).toEqual([STALE_BRANCH_NAME]);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    expect(observed.branchNames).toEqual([FRESH_BRANCH_NAME]);
  });

  it("does not refetch the list without a change event", async () => {
    // The counterfactual for the two cases above: with `staleTime: Infinity` and
    // no event, the row must NOT change. Without this, a test that passes purely
    // because React Query refetched on its own would look like convergence.
    const fake = listFakeSource();
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS * 4);

    expect(fake.listCalls()).toBe(1);
    expect(observed.branchNames).toEqual([STALE_BRANCH_NAME]);
  });

  it("surfaces a failed post-sync refetch as an error, never as a settled empty list", async () => {
    // The false settled state ON the convergence path. Failing only the REFETCH
    // is what makes this about this bridge: a first-load failure would just be
    // TanStack's own default behavior and would pass with the bridge unmounted.
    const fake = listFakeSource({ failAfterFirst: true });
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(observed.branchNames).toEqual([STALE_BRANCH_NAME]);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    expect(fake.listCalls()).toBeGreaterThan(1);
    expect(observed.status).toBe("error");
    expect(observed.status).not.toBe("success");
    // Last-known rows are retained rather than blanked, so a failed read can
    // never manufacture an empty table that reads as "no branches exist".
    expect(observed.branchNames).toEqual([STALE_BRANCH_NAME]);
  });
});

function queryStatus(query: { isError: boolean; isSuccess: boolean }) {
  if (query.isError) {
    return "error";
  }
  if (query.isSuccess) {
    return "success";
  }
  return "pending";
}
