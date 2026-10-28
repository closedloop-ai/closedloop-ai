import {
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Status } from "@repo/api/src/types/result";
import { TagEntityType } from "@repo/api/src/types/tag";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSessionKeys } from "../../../agents/hooks/agent-session-keys";
import { branchRowQueryKeys } from "../../../branches/hooks/branch-query-keys";
import { ApiError } from "../../../shared/api/api-error";
import { API_NO_RESPONSE_STATUS } from "../../../shared/api/api-timeout";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { createTestQueryClient } from "../../../shared/test-utils";
import { BulkTagMutation } from "../../lib/bulk-tag-mutation";
import { createDeferred } from "../../test-fixtures/deferred";
import { useBatchTagPerItem } from "../use-batch-tag-per-item";

const INPUT = {
  tagId: "tag-a",
  entityType: TagEntityType.Artifact,
  entityIds: ["artifact-a", "artifact-b"],
};

let releaseBranchObserver: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseBranchObserver?.();
  releaseBranchObserver = undefined;
});

describe("per-item tag transport", () => {
  it("posts removals only to the remove route and preserves ISS-10686 outcomes", async () => {
    const requests: unknown[] = [];
    const { result } = renderHook(
      () => useBatchTagPerItem(BulkTagMutation.Remove),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "POST",
                path: `${BatchMutationRoute.EntityTagsRemove}/v2`,
                respond: ({ body }) => {
                  requests.push(body);
                  return {
                    results: [
                      batchItemAppliedWithOutcome(
                        "artifact-a",
                        BatchItemAppliedOutcome.Removed
                      ),
                      batchItemAppliedWithOutcome(
                        "artifact-b",
                        BatchItemAppliedOutcome.NotPresent
                      ),
                    ],
                  };
                },
              },
            ]}
          >
            {children}
          </AppCoreStoryProviders>
        ),
      }
    );

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync(INPUT);
    });

    expect(requests).toEqual([INPUT]);
    expect(response).toEqual({
      results: [
        batchItemAppliedWithOutcome(
          "artifact-a",
          BatchItemAppliedOutcome.Removed
        ),
        batchItemAppliedWithOutcome(
          "artifact-b",
          BatchItemAppliedOutcome.NotPresent
        ),
      ],
    });
  });

  it("does not fall back to the add route when remove v2 returns 404", async () => {
    const legacyRequests: unknown[] = [];
    const { result } = renderHook(
      () => useBatchTagPerItem(BulkTagMutation.Remove),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "POST",
                path: `${BatchMutationRoute.EntityTagsRemove}/v2`,
                status: Status.NotFound,
                respond: () => undefined,
              },
              {
                method: "POST",
                path: BatchMutationRoute.EntityTags,
                respond: ({ body }) => {
                  legacyRequests.push(body);
                  return { appliedCount: 2 };
                },
              },
            ]}
          >
            {children}
          </AppCoreStoryProviders>
        ),
      }
    );

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        ApiError
      );
    });
    expect(legacyRequests).toEqual([]);
  });

  it("forwards mutate failure callbacks without admitting a queued departed account", async () => {
    const input = Object.freeze({ ...INPUT, entityIds: [...INPUT.entityIds] });
    const queue = createDeferred<void>();
    const queued = createDeferred<void>();
    const settled = createDeferred<void>();
    const requests: unknown[] = [];
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn(() => settled.resolve());
    let orgId = "org-first";
    const { result, rerender } = renderHook(
      () => ({
        mutation: useBatchTagPerItem(BulkTagMutation.Add),
        client: useQueryClient(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "POST",
                path: `${BatchMutationRoute.EntityTags}/v2`,
                respond: ({ body }) => {
                  requests.push(body);
                  return { results: INPUT.entityIds.map(batchItemApplied) };
                },
              },
            ]}
          >
            <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
              {children}
            </AuthAdapterProvider>
          </AppCoreStoryProviders>
        ),
      }
    );
    result.current.client.getMutationCache().config.onMutate = () => {
      queued.resolve();
      return queue.promise;
    };
    await act(async () => {
      result.current.mutation.mutate(input, { onSuccess, onError, onSettled });
      await queued.promise;
    });
    orgId = "org-other";
    rerender();
    await act(async () => {
      queue.resolve();
      await settled.promise;
    });
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    expect(requests).toEqual([]);
    expect(input).toEqual(INPUT);
    expect(result.current.mutation.variables).toEqual(INPUT);
    expect(result.current.mutation.error).toBeInstanceOf(ApiError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.slice(0, 2)).toEqual([
      result.current.mutation.error,
      INPUT,
    ]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.slice(0, 3)).toEqual([
      undefined,
      result.current.mutation.error,
      INPUT,
    ]);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("forwards mutate callbacks, results and variables without mutating the caller input", async () => {
    const input = Object.freeze({ ...INPUT, entityIds: [...INPUT.entityIds] });
    const requests: unknown[] = [];
    const settled = createDeferred<void>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn(() => settled.resolve());
    const { result } = renderHook(
      () => useBatchTagPerItem(BulkTagMutation.Add),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "POST",
                path: `${BatchMutationRoute.EntityTags}/v2`,
                respond: ({ body }) => {
                  requests.push(body);
                  return { results: INPUT.entityIds.map(batchItemApplied) };
                },
              },
            ]}
          >
            {children}
          </AppCoreStoryProviders>
        ),
      }
    );
    await act(async () => {
      expect(
        result.current.mutate(input, { onSuccess, onError, onSettled })
      ).toBe(undefined);
      await settled.promise;
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(input).toEqual(INPUT);
    expect(requests).toEqual([INPUT]);
    const response = { results: INPUT.entityIds.map(batchItemApplied) };
    expect(result.current.data).toEqual(response);
    expect(result.current.variables).toEqual(INPUT);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.slice(0, 2)).toEqual([response, INPUT]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.slice(0, 3)).toEqual([
      response,
      null,
      INPUT,
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps overlapping submissions of the SAME caller input bound to their original accounts", async () => {
    const input = Object.freeze({ ...INPUT, entityIds: [...INPUT.entityIds] });
    const queues = [createDeferred<void>(), createDeferred<void>()];
    const entered = [createDeferred<void>(), createDeferred<void>()];
    const requests: unknown[] = [];
    const onSuccess = vi.fn();
    const key = agentSessionKeys.list("overlapping-submission-scope", {});
    let orgId = "org-first";
    const { result, rerender } = renderHook(
      () => ({
        mutation: useBatchTagPerItem(BulkTagMutation.Add),
        client: useQueryClient(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "POST",
                path: `${BatchMutationRoute.EntityTags}/v2`,
                respond: ({ body }) => {
                  requests.push(body);
                  return { results: INPUT.entityIds.map(batchItemApplied) };
                },
              },
            ]}
            queryData={[[key, []]]}
          >
            <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
              {children}
            </AuthAdapterProvider>
          </AppCoreStoryProviders>
        ),
      }
    );
    const client = result.current.client;
    let position = 0;
    client.getMutationCache().config.onMutate = () => {
      const index = position++;
      entered[index].resolve();
      return queues[index].promise;
    };
    let first: Promise<void> | undefined;
    let firstOutcome: unknown;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.mutation.mutateAsync(input).then(
        (value) => {
          firstOutcome = value;
        },
        (error: unknown) => {
          firstOutcome = error;
        }
      );
      await entered[0].promise;
    });
    orgId = "org-other";
    rerender();
    await act(async () => {
      second = result.current.mutation.mutateAsync(input, { onSuccess });
      await entered[1].promise;
    });
    await act(async () => {
      queues[0].resolve();
      await first;
    });
    expect(firstOutcome).toBeInstanceOf(ApiError);
    expect(requests).toEqual([]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    const response = { results: INPUT.entityIds.map(batchItemApplied) };
    await act(async () => {
      queues[1].resolve();
      await expect(second).resolves.toEqual(response);
    });
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    expect(requests).toEqual([INPUT]);
    expect(input).toEqual(INPUT);
    expect(result.current.mutation.variables).toEqual(INPUT);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.slice(0, 2)).toEqual([response, INPUT]);
  });

  it.each(["same", "switch"] as const)(
    "retains submitted authority across real queued onMutate (%s, DT-R10)",
    async (ending) => {
      const queue = createDeferred<void>();
      const queued = createDeferred<void>();
      const requests: unknown[] = [];
      const key = agentSessionKeys.list("queued-submission-scope", {});
      let orgId = "org-first";
      const { result, rerender } = renderHook(
        () => ({
          mutation: useBatchTagPerItem(BulkTagMutation.Add),
          client: useQueryClient(),
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <AppCoreStoryProviders
              apiRoutes={[
                {
                  method: "POST",
                  path: `${BatchMutationRoute.EntityTags}/v2`,
                  respond: ({ body }) => {
                    requests.push(body);
                    return { results: INPUT.entityIds.map(batchItemApplied) };
                  },
                },
              ]}
              queryData={[[key, []]]}
            >
              <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
                {children}
              </AuthAdapterProvider>
            </AppCoreStoryProviders>
          ),
        }
      );
      const client = result.current.client;
      client.getMutationCache().config.onMutate = () => {
        queued.resolve();
        return queue.promise;
      };
      let pending: Promise<void> | undefined;
      let outcome: unknown;
      await act(async () => {
        pending = result.current.mutation.mutateAsync(INPUT).then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          }
        );
        await queued.promise;
      });
      if (ending === "switch") {
        orgId = "org-other";
        rerender();
      }
      await act(async () => {
        queue.resolve();
        await pending;
      });
      expect(requests).toEqual(ending === "same" ? [INPUT] : []);
      if (ending === "same") {
        expect(outcome).toEqual({
          results: INPUT.entityIds.map(batchItemApplied),
        });
      } else {
        expect(outcome).toBeInstanceOf(ApiError);
      }
      expect(client.getQueryState(key)?.isInvalidated).toBe(ending === "same");
    }
  );
  it.each(["same", "switch"] as const)(
    "admits the real HTTP404 continuation only under valid %s authority (DT-B04/R10)",
    async (ending) => {
      const receipt = createDeferred<unknown>();
      const started = createDeferred<void>();
      const v2Requests: unknown[] = [];
      const legacyRequests: unknown[] = [];
      const key = agentSessionKeys.list("404-continuation-scope", {});
      let orgId = "org-first";
      const { result, rerender } = renderHook(
        () => ({
          mutation: useBatchTagPerItem(BulkTagMutation.Add),
          client: useQueryClient(),
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <AppCoreStoryProviders
              apiRoutes={[
                {
                  method: "POST",
                  path: `${BatchMutationRoute.EntityTags}/v2`,
                  status: Status.NotFound,
                  respond: ({ body }) => {
                    v2Requests.push(body);
                    started.resolve();
                    return receipt.promise;
                  },
                },
                {
                  method: "POST",
                  path: BatchMutationRoute.EntityTags,
                  respond: ({ body }) => {
                    legacyRequests.push(body);
                    return { appliedCount: INPUT.entityIds.length };
                  },
                },
              ]}
              queryData={[[key, []]]}
            >
              <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
                {children}
              </AuthAdapterProvider>
            </AppCoreStoryProviders>
          ),
        }
      );
      const client = result.current.client;
      let pending: Promise<void> | undefined;
      let outcome: unknown;
      await act(async () => {
        pending = result.current.mutation.mutateAsync(INPUT).then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          }
        );
        await started.promise;
      });
      if (ending === "switch") {
        orgId = "org-other";
        rerender();
      }
      await act(async () => {
        receipt.resolve(undefined);
        await pending;
      });
      expect(v2Requests).toEqual([INPUT]);
      expect(legacyRequests).toEqual(ending === "same" ? [INPUT] : []);
      if (ending === "same") {
        expect(outcome).toEqual({
          results: INPUT.entityIds.map(batchItemApplied),
        });
      } else {
        expect(outcome).toBeInstanceOf(ApiError);
      }
      expect(client.getQueryState(key)?.isInvalidated).toBe(ending === "same");
    }
  );
  it.each([
    { label: "HTTP403", status: Status.Forbidden, network: false },
    { label: "HTTP500", status: Status.Error, network: false },
    { label: "network", status: API_NO_RESPONSE_STATUS, network: true },
  ])(
    "does not attempt legacy POST after real $label rejection (DT-B04)",
    async ({ status, network }) => {
      const errorMessage = "fixture v2 rejection";
      const v2Requests: unknown[] = [];
      const legacyRequests: unknown[] = [];
      const sessionKey = agentSessionKeys.list("non-404-scope", {});
      const branchKey = [...branchRowQueryKeys.lists, "non-404-scope"];
      const routes: FixtureRoute[] = [
        {
          method: "POST",
          path: `${BatchMutationRoute.EntityTags}/v2`,
          ...(network ? {} : { status }),
          error: errorMessage,
          respond: ({ body }) => {
            v2Requests.push(body);
            if (network) {
              throw new TypeError(errorMessage);
            }
            return undefined;
          },
        },
        {
          method: "POST",
          path: BatchMutationRoute.EntityTags,
          respond: ({ body }) => {
            legacyRequests.push(body);
            return { appliedCount: INPUT.entityIds.length };
          },
        },
      ];
      const { result } = renderHook(
        () => ({
          mutation: useBatchTagPerItem(BulkTagMutation.Add),
          client: useQueryClient(),
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <AppCoreStoryProviders
              apiRoutes={routes}
              queryData={[
                [sessionKey, []],
                [branchKey, []],
              ]}
            >
              {children}
            </AppCoreStoryProviders>
          ),
        }
      );
      await act(async () => {
        await expect(
          result.current.mutation.mutateAsync(INPUT)
        ).rejects.toMatchObject({ status, message: errorMessage });
      });
      await waitFor(() => expect(result.current.mutation.isError).toBe(true));
      expect(result.current.mutation.error).toBeInstanceOf(ApiError);
      expect(result.current.mutation.isError).toBe(true);
      expect(v2Requests).toEqual([INPUT]);
      expect(legacyRequests).toEqual([]);
      expect(
        result.current.client.getQueryState(sessionKey)?.isInvalidated
      ).toBe(false);
      expect(
        result.current.client.getQueryState(branchKey)?.isInvalidated
      ).toBe(false);
    }
  );
  it("does not invalidate the new account's cache after an old-scope response", async () => {
    let orgId = "org-a";
    const receipt = createDeferred<unknown>();
    const started = createDeferred<void>();
    const key = agentSessionKeys.list("scope-test", {});
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: () => {
              started.resolve();
              return receipt.promise;
            },
          },
        ]}
        queryData={[[key, []]]}
      >
        <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
          {children}
        </AuthAdapterProvider>
      </AppCoreStoryProviders>
    );
    const { result, rerender } = renderHook(
      () => ({
        mutation: useBatchTagPerItem(BulkTagMutation.Add),
        client: useQueryClient(),
      }),
      { wrapper }
    );
    let pending: Promise<unknown> | undefined;
    await act(async () => {
      pending = result.current.mutation.mutateAsync(INPUT);
      await started.promise;
    });
    orgId = "org-b";
    rerender();
    await act(async () => {
      receipt.resolve({ results: INPUT.entityIds.map(batchItemApplied) });
      await pending;
    });
    expect(result.current.client.getQueryState(key)?.isInvalidated).toBe(false);
  });
  it("uses v2 and invalidates both app and Desktop Branch clients only on confirmed success", async () => {
    const requests: unknown[] = [];
    const branchClient = createTestQueryClient();
    const branchKey = [...branchRowQueryKeys.lists, "desktop"];
    branchClient.setQueryData(branchKey, []);
    const branchObserver = new QueryObserver(branchClient, {
      queryKey: branchKey,
      enabled: false,
    });
    releaseBranchObserver = branchObserver.subscribe(() => undefined);
    const routes: FixtureRoute[] = [
      {
        method: "POST",
        path: "/entity-tags/batch/v2",
        respond: ({ body }) => {
          requests.push(body);
          return {
            results: [
              batchItemApplied(INPUT.entityIds[0]),
              batchItemFailed(
                INPUT.entityIds[1],
                BatchItemFailureCode.ArtifactsNotFound
              ),
            ],
          };
        },
      },
    ];
    const sessionKey = agentSessionKeys.list("org-test", {});
    const { result } = renderHook(
      () => ({
        mutation: useBatchTagPerItem(BulkTagMutation.Add, branchClient),
        client: useQueryClient(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={routes}
            queryData={[[sessionKey, []]]}
          >
            {children}
          </AppCoreStoryProviders>
        ),
      }
    );
    await act(async () => {
      await result.current.mutation.mutateAsync(INPUT);
    });
    expect(requests).toEqual([INPUT]);
    expect(result.current.client.getQueryState(sessionKey)?.isInvalidated).toBe(
      true
    );
    expect(branchClient.getQueryState(branchKey)?.isInvalidated).toBe(true);
    branchClient.clear();
  });

  it.each([0, 1, 2])(
    "accepts idempotent atomic v1 count %i after v2 404",
    async (appliedCount) => {
      const legacyRequests: unknown[] = [];
      const routes: FixtureRoute[] = [
        {
          method: "POST",
          path: "/entity-tags/batch/v2",
          status: Status.NotFound,
          respond: () => undefined,
        },
        {
          method: "POST",
          path: "/entity-tags/batch",
          respond: ({ body }) => {
            legacyRequests.push(body);
            return { appliedCount };
          },
        },
      ];
      const { result } = renderHook(
        () => useBatchTagPerItem(BulkTagMutation.Add),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <AppCoreStoryProviders apiRoutes={routes}>
              {children}
            </AppCoreStoryProviders>
          ),
        }
      );
      let receipt: unknown;
      await act(async () => {
        receipt = await result.current.mutateAsync(INPUT);
      });
      expect(legacyRequests).toEqual([INPUT]);
      expect(receipt).toEqual({
        results: INPUT.entityIds.map(batchItemApplied),
      });
    }
  );

  it.each([
    { appliedCount: -1 },
    { appliedCount: 0.5 },
    { appliedCount: 3 },
    { appliedCount: "2" },
    {},
  ])("rejects malformed v1 confirmation %j", async (receipt) => {
    const routes: FixtureRoute[] = [
      {
        method: "POST",
        path: "/entity-tags/batch/v2",
        status: Status.NotFound,
        respond: () => undefined,
      },
      { method: "POST", path: "/entity-tags/batch", respond: () => receipt },
    ];
    const { result } = renderHook(
      () => useBatchTagPerItem(BulkTagMutation.Add),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders apiRoutes={routes}>
            {children}
          </AppCoreStoryProviders>
        ),
      }
    );
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toThrow();
    });
  });

  it.each([
    { results: null },
    { results: [{ id: "artifact-a", status: "200" }] },
    {
      results: [
        batchItemFailed("artifact-a", BatchItemFailureCode.ArtifactsNotFound),
      ],
    },
  ])("does not invalidate or try v1 for unconfirmed v2 %j", async (receipt) => {
    const legacyRequests: unknown[] = [];
    const sessionKey = agentSessionKeys.list("org-test", {});
    const routes: FixtureRoute[] = [
      { method: "POST", path: "/entity-tags/batch/v2", respond: () => receipt },
      {
        method: "POST",
        path: "/entity-tags/batch",
        respond: ({ body }) => {
          legacyRequests.push(body);
          return { appliedCount: 2 };
        },
      },
    ];
    const { result } = renderHook(
      () => ({
        mutation: useBatchTagPerItem(BulkTagMutation.Add),
        client: useQueryClient(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={routes}
            queryData={[[sessionKey, []]]}
          >
            {children}
          </AppCoreStoryProviders>
        ),
      }
    );
    await act(async () => {
      await result.current.mutation.mutateAsync(INPUT).catch(() => undefined);
    });
    expect(legacyRequests).toEqual([]);
    expect(result.current.client.getQueryState(sessionKey)?.isInvalidated).toBe(
      false
    );
  });
});
