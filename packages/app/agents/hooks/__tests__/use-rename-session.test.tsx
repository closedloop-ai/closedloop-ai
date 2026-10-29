import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKeys } from "../agent-session-keys";
import { useRenameSession } from "../use-rename-session";

/**
 * ISS-8718 — the CACHE half of the rename, which the lead-cell suite cannot
 * reach: that cell renders from its `row` prop, so its own "previous name comes
 * back" assertion pins the editor's commit ledger and stays green with the
 * rollback deleted (measured). The optimistic rewrite and its rollback are only
 * observable where the list actually reads from — the query cache — so they are
 * asserted here, against the keys the hook names.
 *
 * The client is the PROVIDER's, read through `useQueryClient` beside the
 * mutation. A client built in this file would be a different cache from the one
 * the hook writes to, and every assertion below would be vacuous.
 */

const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const OTHER_SESSION_ID = "55555555-5555-4555-8555-555555555552";
const LIST_KEY = agentSessionKeys.lists();
const COLLECTED_NAME = "agent/refactor-auth-guard";
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: toastError },
}));

type CachedList = { items: { id: string; name: string }[]; total: number };

function cachedList(): CachedList {
  return {
    items: [
      { id: SESSION_ID, name: COLLECTED_NAME },
      { id: OTHER_SESSION_ID, name: "agent/untouched" },
    ],
    total: 2,
  };
}

function wrapperWith(respond: () => unknown) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders
      apiRoutes={[{ method: "PATCH", path: "/agent-sessions/*", respond }]}
      queryData={[[LIST_KEY, cachedList()]]}
    >
      {children}
    </AppCoreStoryProviders>
  );
}

function renderRename(respond: () => unknown) {
  return renderHook(
    () => ({
      mutation: useRenameSession(ArtifactStatusEditSurface.InlineCell),
      queryClient: useQueryClient(),
    }),
    { wrapper: wrapperWith(respond) }
  );
}

describe("useRenameSession", () => {
  it("rewrites only the renamed session in every cached read", async () => {
    const { result } = renderRename(() => ({}));

    await act(async () => {
      await result.current.mutation.mutateAsync({
        sessionId: SESSION_ID,
        name: "auth guard rewrite",
        expectedName: COLLECTED_NAME,
      });
    });
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));

    const cached =
      result.current.queryClient.getQueryData<CachedList>(LIST_KEY);
    expect(cached?.items).toEqual([
      { id: SESSION_ID, name: "auth guard rewrite" },
      // The sibling row is untouched: the walk matches on id, so a rename must
      // never repaint the rest of the page.
      { id: OTHER_SESSION_ID, name: "agent/untouched" },
    ]);
  });

  it("rolls the cached name back when the server refuses", async () => {
    const { result } = renderRename(() => {
      throw new Error("refused");
    });

    await act(async () => {
      await result.current.mutation
        .mutateAsync({
          sessionId: SESSION_ID,
          name: "never lands",
          expectedName: COLLECTED_NAME,
        })
        .catch(() => {
          // The shared QueryClient's default onError owns the toast; this catch
          // only keeps the rejection from going unhandled in the test.
        });
    });
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));

    // ISS-8718 acceptance: the row never keeps a name the server refused.
    const cached =
      result.current.queryClient.getQueryData<CachedList>(LIST_KEY);
    expect(cached?.items[0]).toEqual({
      id: SESSION_ID,
      name: COLLECTED_NAME,
    });
    expect(
      result.current.queryClient.getMutationCache().getAll()[0]?.options.meta
    ).toBeUndefined();
  });

  it.each([
    ["sends no feedback owner", undefined],
    ["still owns its adjacent feedback", () => true],
  ])("toasts nothing for a refusal whose caller %s", async (_case, owner) => {
    toastError.mockClear();
    const { result } = renderRename(() => {
      throw new Error("refused");
    });

    await act(async () => {
      await result.current.mutation
        .mutateAsync({
          sessionId: SESSION_ID,
          name: "never lands",
          expectedName: COLLECTED_NAME,
          ...(owner ? { recoverableErrorOwner: owner } : {}),
        })
        .catch(() => undefined);
    });

    expect(toastError).not.toHaveBeenCalled();
  });

  it("restores the shared toast when the adjacent rename owner unmounts", async () => {
    toastError.mockClear();
    const { result } = renderRename(() => {
      throw new Error("refused");
    });

    await act(async () => {
      await result.current.mutation
        .mutateAsync({
          sessionId: SESSION_ID,
          name: "never lands",
          expectedName: COLLECTED_NAME,
          recoverableErrorOwner: () => false,
        })
        .catch(() => undefined);
    });

    expect(toastError).toHaveBeenCalledOnce();
  });

  /**
   * tamsinb review, PR #8315. `details()` is the prefix over EVERY cached
   * detail, and a session's events pages and invocation tree nest under its
   * own detail key — so invalidating that prefix for a one-field write marked
   * every loaded events page of every cached session stale. The hook now names
   * `agentSessionDetailRowFilter`, which depth-matches this session's entry.
   *
   * The counterfactual is the old call: putting `agentSessionKeys.details()`
   * back fails this case on the events page.
   */
  it("invalidates this session's detail without touching its events pages or a sibling's detail", async () => {
    const scope = "cloud";
    const eventsKey = agentSessionKeys.eventsPages(scope, SESSION_ID, "c0");
    const ownDetail = agentSessionKeys.detail(scope, SESSION_ID);
    const siblingDetail = agentSessionKeys.detail(scope, OTHER_SESSION_ID);
    const { result } = renderRename(() => ({}));

    act(() => {
      result.current.queryClient.setQueryData(eventsKey, { pages: ["e1"] });
      result.current.queryClient.setQueryData(ownDetail, { id: SESSION_ID });
      result.current.queryClient.setQueryData(siblingDetail, {
        id: OTHER_SESSION_ID,
      });
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        sessionId: SESSION_ID,
        name: "auth guard rewrite",
        expectedName: COLLECTED_NAME,
      });
    });
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));

    const invalidated = (key: readonly unknown[]) =>
      result.current.queryClient.getQueryState(key)?.isInvalidated;
    // The row's own detail carries the name, so it must move.
    expect(invalidated(ownDetail)).toBe(true);
    // Its events pages do not carry the name, and refetching them is the cost
    // this narrowing exists to avoid.
    expect(invalidated(eventsKey)).toBe(false);
    // Another session's detail is not this write's business at all.
    expect(invalidated(siblingDetail)).toBe(false);
  });

  /**
   * whitlockk review, PR #8315. A rename started in org A that fails AFTER an org
   * switch used to restore A's snapshots into B's cache: `onError` wrote
   * unconditionally, and these keys carry the active DATA SOURCE as their scope
   * segment, never an org. `packages/app/AGENTS.md` states the rule — capture
   * the org scope before the first `await` in `onMutate` and recheck it after.
   *
   * The gate holds the request open so the switch lands between the optimistic
   * write and the failure, which is the exact window the bug lived in.
   */
  it("does not roll a failed rename back into another org's cache", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const { result } = renderHook(
      () => ({
        mutation: useRenameSession(ArtifactStatusEditSurface.InlineCell),
        queryClient: useQueryClient(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "PATCH",
                path: "/agent-sessions/*",
                respond: async () => {
                  await gate;
                  throw new Error("refused");
                },
              },
            ]}
            queryData={[[LIST_KEY, cachedList()]]}
          >
            <SwitchableOrg>{children}</SwitchableOrg>
          </AppCoreStoryProviders>
        ),
      }
    );

    const failed = result.current.mutation
      .mutateAsync({
        sessionId: SESSION_ID,
        name: "started in org A",
        expectedName: COLLECTED_NAME,
      })
      .catch(() => {
        // The shared QueryClient's default onError owns the toast.
      });

    // The optimistic write has landed; this is org A's cache.
    await waitFor(() =>
      expect(
        result.current.queryClient.getQueryData<CachedList>(LIST_KEY)?.items[0]
          .name
      ).toBe("started in org A")
    );

    // Its OWN act, so React COMMITS the switch — and the guard's layout effect
    // runs — before the pending write resumes. Batched into one act with the
    // release below, the switch is still uncommitted when `onError` fires, which
    // is the ordering a real org switch never has.
    act(() => {
      switchOrg?.("org_b");
    });
    await act(async () => {
      release?.();
      await failed;
    });
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));

    // NOT rolled back: the snapshot belongs to org A, and writing it here would
    // put A's rows under B's keys. Without the guard this reads
    // `agent/refactor-auth-guard`.
    expect(
      result.current.queryClient.getQueryData<CachedList>(LIST_KEY)?.items[0]
        .name
    ).toBe("started in org A");
  });
});

/** Set by {@link SwitchableOrg} so a case can switch orgs mid-write. */
let switchOrg: ((orgId: string) => void) | null = null;

/**
 * An auth adapter whose `orgId` a case can change, nested INSIDE
 * `AppCoreStoryProviders` so it overrides that harness's static adapter — the
 * nearest provider wins. The state change is what re-renders the guard, so its
 * layout effect sees the new org before the pending write resumes.
 */
function SwitchableOrg({ children }: { children: ReactNode }) {
  const [orgId, setOrgId] = useState("org_a");
  switchOrg = setOrgId;
  const adapter = useMemo(
    () => ({
      useAuthSnapshot: () => ({
        getToken: () => Promise.resolve(null),
        isLoaded: true,
        orgId,
        userId: "user_1",
      }),
    }),
    [orgId]
  );
  return (
    <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
  );
}
