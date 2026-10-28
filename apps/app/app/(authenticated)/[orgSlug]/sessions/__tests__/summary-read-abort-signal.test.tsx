import { createHttpAgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { useAgentSessionUsage } from "@repo/app/agents/hooks/use-agent-sessions";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreAdapterProvider } from "@/lib/app-core-adapters";

/**
 * ISS-7852 on the WEB surface.
 *
 * The shared suite in `@repo/app` proves the Sessions summary hooks hand their
 * read TanStack Query's `AbortSignal` and that it survives the shared API
 * client. What it cannot say is what the WEB SHELL puts behind the
 * `ApiTransportFetch` port, and that is the whole reason this ticket was scoped
 * across two surfaces: `apps/desktop` fills that port with an Electron IPC
 * bridge that cannot forward a signal at all, while `apps/app` fills it with
 * nothing — `AppCoreAdapterProvider`'s adapter declares no `fetch`, so the
 * shared client falls through to the platform `fetch`, which honors an
 * `AbortSignal` natively and really does tear the request down.
 *
 * So this case mounts the REAL web composition root rather than a harness
 * adapter, and asserts against the platform `fetch` seam itself: the init the
 * browser would have received carries a signal, and that signal aborts when the
 * range is superseded. Injecting a signal-ignoring transport into the web shell
 * — or dropping the thread anywhere above it — reds this.
 *
 * NOT what this asserts: that the newest range wins. That was already true on
 * `main` (`agentSessionKeys.usage` carries the filters, so a late answer lands
 * in its own cache entry), so an assertion of that shape is satisfied without
 * this change and proves nothing. Nothing rendered wrongly before; superseded
 * work was simply still paid for.
 */

const SEVEN_DAY_START = "2026-08-20T00:00:00.000Z";
const THIRTY_DAY_START = "2026-07-28T00:00:00.000Z";
const USAGE_PATH = "/agent-sessions/usage";
const LOCAL_TRUSTED_IDENTITY = {
  orgId: "org_iss7852",
  orgSlug: "iss7852",
  userId: "user_iss7852",
};

type RecordedRequest = { url: string; signal: AbortSignal | null | undefined };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stands in for the browser's own `fetch`: records the init it was handed and
 * never answers, rejecting the way a real one does once its signal fires.
 */
function stubPlatformFetch(recorded: RecordedRequest[]) {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      recorded.push({ url: String(input), signal });
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  );
}

/** The real HTTP data source over the real shared client — no double between. */
function HttpSourceProvider({ children }: { children: ReactNode }) {
  const api = useApiClient();
  return (
    <AgentSessionsDataSourceProvider
      dataSource={createHttpAgentSessionsDataSource(api)}
    >
      {children}
    </AgentSessionsDataSourceProvider>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // The web shell's own composition root. `localTrustedAuthIdentity` picks the
  // static auth adapter it already ships for local_trusted harnesses, so the
  // API adapter under test is the real one without a live Clerk session.
  return (
    <AppCoreAdapterProvider localTrustedAuthIdentity={LOCAL_TRUSTED_IDENTITY}>
      <QueryClientProvider client={client}>
        <HttpSourceProvider>{children}</HttpSourceProvider>
      </QueryClientProvider>
    </AppCoreAdapterProvider>
  );
}

describe("the web Sessions summary read aborts a superseded range (ISS-7852)", () => {
  it("aborts at the platform fetch the web shell leaves in place", async () => {
    const recorded: RecordedRequest[] = [];
    stubPlatformFetch(recorded);

    const { rerender } = renderHook(
      ({ startDate }: { startDate: string }) =>
        useAgentSessionUsage({ startDate }),
      {
        initialProps: { startDate: SEVEN_DAY_START },
        wrapper: Wrapper,
      }
    );

    await waitFor(() =>
      expect(recorded.some((request) => request.url.includes(USAGE_PATH))).toBe(
        true
      )
    );
    const superseded = recorded.find((request) =>
      request.url.includes(USAGE_PATH)
    );
    // Live before the supersession, or "aborted" below was already true when it
    // was written and could never fail.
    expect(superseded?.signal?.aborted).toBe(false);

    rerender({ startDate: THIRTY_DAY_START });

    await waitFor(() => expect(superseded?.signal?.aborted).toBe(true));
  });
});
