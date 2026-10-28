/**
 * @description ISS-7830, on the PRODUCTION path.
 *
 * The capture is the whole feature, and its failure mode is a dead call site: a
 * hook nobody invokes leaves every other suite green while the signal is never
 * recorded and every opened subagent thread keeps scoring headless. So these
 * drive the real `SessionDetailView` and assert what crossed
 * `window.desktopApi.db.markSessionViewed`.
 *
 * The duplicate-suppression case runs under `StrictMode` on purpose. A plain
 * re-render with an unchanged `sessionId` does NOT re-invoke an effect keyed on
 * `[sessionId]`, so asserting a call count across two `rerender`s would stay
 * green with the marker deleted — it would be measuring React's dependency array,
 * not the guard. StrictMode's doubled MOUNT effect is the mutation the marker
 * actually exists to absorb.
 */
import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import { type ReactElement, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";
import { sessionDetail } from "./fixtures/session-detail-fixture";

const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

const VIEWED_SESSION_ID = "iss7830-opened-thread";
const OTHER_SESSION_ID = "iss7830-second-thread";
const NOT_FOUND_HEADING = /session not found/i;
/**
 * The two id spaces the capture has to tell apart. In CLOUD mode the route id
 * is the cloud `artifactId` and `session_viewership` is keyed by the local
 * `sessions.id` — the harness `externalSessionId` — so they are different
 * values and only the second one can ever match a row.
 */
const CLOUD_ARTIFACT_ID = "0199c435-9d43-747e-8d26-b7377f2c4519";
const LOCAL_EXTERNAL_SESSION_ID = "iss7830-local-external-id";

function installDesktopApi(
  recorded: boolean,
  detail: AgentSessionDetail | null = null
) {
  const markSessionViewed =
    vi.fn<(id: string) => Promise<{ recorded: boolean }>>();
  markSessionViewed.mockResolvedValue({ recorded });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: { detail: vi.fn(async () => detail) },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
        markSessionViewed,
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      recordDeadEndTelemetry: vi.fn(async () => ({ ok: true })),
    },
  });
  return markSessionViewed;
}

function withProviders(ui: ReactElement) {
  return (
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
    >
      <DesktopAppCoreProvider>{ui}</DesktopAppCoreProvider>
    </NavigationProvider>
  );
}

function detailView(sessionId: string) {
  return withProviders(
    <SessionDetailView backHref="/sessions" sessionId={sessionId} />
  );
}

describe("SessionDetailView thread-viewership wiring", () => {
  beforeEach(() => {
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  it("records the view when the detail route mounts", async () => {
    const markSessionViewed = installDesktopApi(true);
    render(detailView(VIEWED_SESSION_ID));

    await waitFor(() => expect(markSessionViewed).toHaveBeenCalled());
    expect(markSessionViewed.mock.calls).toEqual([[VIEWED_SESSION_ID]]);
  });

  it("sends one message under StrictMode's doubled mount effect", async () => {
    // The marker's real job. Delete it and StrictMode drives two IPC messages
    // for one navigation.
    const markSessionViewed = installDesktopApi(true);
    render(<StrictMode>{detailView(VIEWED_SESSION_ID)}</StrictMode>);

    await waitFor(() => expect(markSessionViewed).toHaveBeenCalled());
    expect(markSessionViewed).toHaveBeenCalledTimes(1);
  });

  it("re-attempts the same thread on a later mount, so the marker is not a latch", async () => {
    // The sibling that makes the suppression above safe, and the only retry a
    // fire-and-forget capture honestly has. The marker is scoped to the MOUNTED
    // VIEW; hoist it to module scope and one refused capture (the Labs gate off,
    // a session this device holds no row for) would drop every future view of
    // that thread for the life of the process.
    const markSessionViewed = installDesktopApi(false);
    const { unmount } = render(detailView(VIEWED_SESSION_ID));
    await waitFor(() => expect(markSessionViewed).toHaveBeenCalledTimes(1));
    unmount();

    render(detailView(VIEWED_SESSION_ID));
    await waitFor(() => expect(markSessionViewed).toHaveBeenCalledTimes(2));
    expect(markSessionViewed.mock.calls).toEqual([
      [VIEWED_SESSION_ID],
      [VIEWED_SESSION_ID],
    ]);
  });

  it("still attempts the capture when the detail read comes back not-found", async () => {
    // A session that never loads was still OPENED. Gating the ATTEMPT on a
    // settled read would lose the view for exactly the not-found and offline
    // cases. Whether it lands is the store's call (it refuses a session this
    // device holds no row for) — the renderer's job is to state the navigation.
    const markSessionViewed = installDesktopApi(false);
    render(detailView(VIEWED_SESSION_ID));

    await screen.findByText(NOT_FOUND_HEADING);
    expect(markSessionViewed).toHaveBeenCalledWith(VIEWED_SESSION_ID);
  });

  it("corrects the id to the local externalSessionId the settled cloud detail carries", async () => {
    // The Cloud-mode defect (tamsinb, cid 3845388737). The route id there is
    // `record.artifactId`, which matches no `sessions` row, so a capture that
    // only ever states the route id records nothing and the feature is dead on
    // the entire authenticated surface. The settled detail carries the local
    // key, and stating THAT is what makes the write land.
    const markSessionViewed = installDesktopApi(
      true,
      sessionDetail({
        id: CLOUD_ARTIFACT_ID,
        name: "Cloud Routed Session",
        overrides: { externalSessionId: LOCAL_EXTERNAL_SESSION_ID },
        status: "active",
      })
    );
    render(detailView(CLOUD_ARTIFACT_ID));

    expect(
      await screen.findByRole("heading", { name: "Cloud Routed Session" })
    ).toBeDefined();
    await waitFor(() =>
      expect(markSessionViewed).toHaveBeenCalledWith(LOCAL_EXTERNAL_SESSION_ID)
    );
  });

  it("sends one message in local mode, where the route id already is the external id", async () => {
    // The other half of the same change, and the reason it is safe to leave the
    // mount-time attempt unconditional: when the settled detail reports the id
    // the route already carried, the hook must NOT re-fire. Asserted only after
    // the detail has demonstrably settled, so a second message would be visible
    // here rather than raced past.
    const markSessionViewed = installDesktopApi(
      true,
      sessionDetail({
        id: VIEWED_SESSION_ID,
        name: "Local Routed Session",
        overrides: { externalSessionId: VIEWED_SESSION_ID },
        status: "active",
      })
    );
    render(detailView(VIEWED_SESSION_ID));

    expect(
      await screen.findByRole("heading", { name: "Local Routed Session" })
    ).toBeDefined();
    expect(markSessionViewed.mock.calls).toEqual([[VIEWED_SESSION_ID]]);
  });

  it("records the second thread when navigation moves to a different session", async () => {
    // A once-ever latch would pass the suppression case and silently stop
    // capturing for the rest of the app's lifetime.
    const markSessionViewed = installDesktopApi(true);
    const { rerender } = render(detailView(VIEWED_SESSION_ID));

    await waitFor(() => expect(markSessionViewed).toHaveBeenCalled());
    rerender(detailView(OTHER_SESSION_ID));

    await waitFor(() =>
      expect(markSessionViewed).toHaveBeenCalledWith(OTHER_SESSION_ID)
    );
    expect(markSessionViewed.mock.calls).toEqual([
      [VIEWED_SESSION_ID],
      [OTHER_SESSION_ID],
    ]);
  });
});
