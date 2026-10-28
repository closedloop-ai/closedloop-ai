import type { AgentSessionDetailViewProps } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";

/**
 * @description ISS-11004 — the PRODUCTION WIRING of the Activity tab's comment
 * link on the desktop shell: this shell owns the URL, so it is what reads
 * `?comment=` and forwards it to the shared view.
 *
 * The rest of the chain is graded elsewhere: the param codec
 * (`packages/app/shared/lib/__tests__/artifact-comment-href`), the rail's mark
 * and reveal (`packages/app/.../trace-comments-rail-selected-comment`), the
 * rail state's reveal of a collapsed rail
 * (`packages/app/.../use-comments-rail-state-addressed-comment`), and the web
 * shell's own read (`apps/app/.../sessions/[id]/__tests__/page.test.tsx`). All
 * of those stay green if THIS shell stops reading the param or forwards it to
 * the wrong prop, which is the one thing only this file can fail on.
 *
 * The no-address case is load-bearing: a shell that hard-coded an id would
 * pass the first case alone.
 */
const SESSION_ID = "addressed-comment-session";

const { searchParamsMock, detailViewMock } = vi.hoisted(() => ({
  searchParamsMock: vi.fn(),
  detailViewMock: vi.fn(),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@repo/app/agents/components/detail/agent-session-detail-view", () => ({
  AgentSessionDetailView: (props: AgentSessionDetailViewProps) => {
    detailViewMock(props);
    return <div data-testid="session-detail-body" />;
  },
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

beforeEach(() => {
  searchParamsMock.mockReset();
  searchParamsMock.mockReturnValue(new URLSearchParams());
  detailViewMock.mockClear();
  installDesktopApi();
});

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.restoreAllMocks();
});

describe("Desktop session detail addressed comment", () => {
  it("forwards the comment the URL addresses", () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams({ comment: "comment-42" })
    );

    renderDesktopShell();

    expect(detailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ selectedThreadId: "comment-42" })
    );
  });

  it("forwards no addressed comment when the URL names none", () => {
    renderDesktopShell();

    expect(detailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ selectedThreadId: null })
    );
  });
});

function installDesktopApi(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(() => Promise.resolve(null)),
        detail: vi.fn(() => new Promise(() => undefined)),
        list: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
        usage: vi.fn(() => Promise.resolve(null)),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
    },
  });
}

function renderDesktopShell() {
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider
        adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
      >
        <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}
