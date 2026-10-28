import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import { stalePriorityConflict } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useArtifactPriorityMutation } from "@repo/app/shared/hooks/use-artifact-priority-mutation";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9491 — the Sessions and Branches priority cells' shared write engine,
 * against a server that answers the way `PATCH /agent-sessions/[id]` and
 * `PATCH /branches/[id]` do: the ISS-9486 guard (`expectedPriority`) refuses
 * with `stale_priority` unless the requested value already holds.
 *
 * Both Web and Desktop mount this engine (Desktop cloud mode through the same
 * HTTP source, local mode through a source that throws the same 409), so what
 * the reader is left looking at after a refusal is decided here once.
 */

const ID = "55555555-5555-4555-8555-555555555591";
const ROWS_KEY = ["iss9491-priority-rows"] as const;

type Rows = { items: { id: string; priority: Priority | null }[] };

function fakeServer(initial: Priority | null) {
  const state = {
    stored: initial,
    writes: [] as UpdateArtifactPriorityRequest[],
  };
  let heldRead: Promise<void> | undefined;
  let releaseRead: () => void = () => undefined;
  return {
    state,
    holdReads() {
      heldRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseReads() {
      releaseRead();
      heldRead = undefined;
    },
    async read(): Promise<Rows> {
      await heldRead;
      return { items: [{ id: ID, priority: state.stored }] };
    },
    guardedWrite(input: UpdateArtifactPriorityRequest) {
      state.writes.push(input);
      const stale =
        input.expectedPriority !== undefined &&
        input.expectedPriority !== state.stored &&
        input.priority !== state.stored;
      if (stale) {
        const conflict = stalePriorityConflict([]);
        throw new ApiError(conflict.message, conflict.status, conflict.code);
      }
      state.stored = input.priority;
    },
  };
}

/** `apply` answers the write as the transport would, after a network hop. */
function renderEngine(
  server: ReturnType<typeof fakeServer>,
  apply: (input: UpdateArtifactPriorityRequest) => void
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = renderHook(
    () => ({
      rows: useQuery({ queryKey: ROWS_KEY, queryFn: () => server.read() }),
      mutation: useArtifactPriorityMutation({
        queryKeyRoots: [ROWS_KEY],
        surface: ArtifactStatusEditSurface.InlineCell,
        write: (_id, input) => Promise.resolve().then(() => apply(input)),
      }),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  const shown = () => rendered.result.current.rows.data?.items[0]?.priority;
  return { ...rendered, shown };
}

describe("useArtifactPriorityMutation: a refused write converges on the server's value", () => {
  it("refuses a lost update, puts back what the reader saw, then shows what the other writer committed", async () => {
    const server = fakeServer(Priority.Low);
    const { result, shown } = renderEngine(server, (input) =>
      server.guardedWrite(input)
    );
    await waitFor(() => expect(shown()).toBe(Priority.Low));

    // Another writer commits while this reader still shows LOW.
    server.state.stored = Priority.Medium;
    server.holdReads();
    act(() => {
      result.current.mutation.mutate({
        artifactId: ID,
        priority: Priority.High,
        expectedPriority: Priority.Low,
      });
    });

    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    expect(server.state.writes).toEqual([
      {
        priority: Priority.High,
        expectedPriority: Priority.Low,
        surface: ArtifactStatusEditSurface.InlineCell,
      },
    ]);
    // The refused pick is not left on screen while the re-read is in flight.
    expect(shown()).toBe(Priority.Low);

    server.releaseReads();
    await waitFor(() => expect(shown()).toBe(Priority.Medium));
  });

  it("does not keep a pick whose outcome is unknown, then shows it once the re-read confirms the lost response committed", async () => {
    const server = fakeServer(Priority.Low);
    const { result, shown } = renderEngine(server, (input) => {
      server.guardedWrite(input);
      throw new TypeError("Failed to fetch");
    });
    await waitFor(() => expect(shown()).toBe(Priority.Low));

    server.holdReads();
    act(() => {
      result.current.mutation.mutate({
        artifactId: ID,
        priority: Priority.High,
        expectedPriority: Priority.Low,
      });
    });

    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    expect(shown()).toBe(Priority.Low);

    server.releaseReads();
    await waitFor(() => expect(shown()).toBe(Priority.High));
  });
});
