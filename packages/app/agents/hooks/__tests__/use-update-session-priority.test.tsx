import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { agentSessionKeys } from "@repo/app/agents/hooks/agent-session-keys";
import { useUpdateSessionPriority } from "@repo/app/agents/hooks/use-update-session-priority";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-10332 (#7762 review): a priority click rewrites and refetches only the
 * Sessions reads that carry a row's priority. Every seeded entry below holds
 * the target row, so a walk over the whole `agent-sessions` prefix would patch
 * and invalidate the usage and transcript entries too.
 */

const ID = "55555555-5555-4555-8555-555555555552";
const SCOPE = "test-scope";

describe("useUpdateSessionPriority", () => {
  it("patches and invalidates list, page data and detail, and nothing else", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      },
    });
    const carried = [
      agentSessionKeys.list(SCOPE, {}),
      agentSessionKeys.pageData(SCOPE, {}),
      agentSessionKeys.detail(SCOPE, ID),
    ];
    const untouched = [
      agentSessionKeys.usage(SCOPE, {}),
      agentSessionKeys.analytics(SCOPE, {}),
      agentSessionKeys.transcriptFile(ID, "main", "sha"),
    ];
    for (const key of [...carried, ...untouched]) {
      client.setQueryData(key, { items: [{ id: ID, priority: Priority.Low }] });
    }
    const before = untouched.map((key) => client.getQueryData(key));
    const updatePriority = vi.fn().mockResolvedValue(undefined);
    const source = {
      scope: SCOPE,
      updatePriority,
    } as unknown as AgentSessionsDataSource;
    const { result } = renderHook(
      () => useUpdateSessionPriority(ArtifactStatusEditSurface.InlineCell),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders>
            <QueryClientProvider client={client}>
              <AgentSessionsDataSourceProvider dataSource={source}>
                {children}
              </AgentSessionsDataSourceProvider>
            </QueryClientProvider>
          </AppCoreStoryProviders>
        ),
      }
    );

    await act(() =>
      result.current.mutateAsync({ artifactId: ID, priority: Priority.High })
    );

    expect(updatePriority).toHaveBeenCalledTimes(1);
    for (const key of carried) {
      expect(client.getQueryData(key)).toEqual({
        items: [{ id: ID, priority: Priority.High }],
      });
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    untouched.forEach((key, index) => {
      expect(client.getQueryData(key)).toBe(before[index]);
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    });
  });
});
