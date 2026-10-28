import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import {
  makeComponent,
  makeDetail,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { useAgentComponentDetail } from "@repo/app/agents/hooks/use-agent-component-detail";
import { useAgentComponents } from "@repo/app/agents/hooks/use-agent-components";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";

/**
 * ISS-6882 — end-to-end proof that a local component DB change reaches the
 * rendered Agents-workspace population.
 *
 * This composes the REAL production stack: `DesktopAppCoreProvider` builds the
 * real `createLocalAgentComponentsDataSource` over the preload's `onDbChanged`,
 * mounts whatever live bridge it mounts, and supplies the real local
 * QueryClient (`staleTime: Infinity`, focus and reconnect refetches OFF). Only
 * the preload IPC surface is faked. Nothing here reaches into the bridge or the
 * query client directly, so the assertions fail if ANY link is missing:
 * the bridge mount, the subscription, or the change→identity mapping.
 *
 * Every case primes the cache before mutating the fixture, which is the point:
 * under `staleTime: Infinity` an unprimed query would refetch on its own and the
 * assertion would pass with no invalidation channel at all.
 */

type DbChangePayload = { sessionId?: string };

const dbChangeSubscribers = new Set<(payload: DbChangePayload) => void>();
const rendererTextTimeoutMs = 10_000;
const rendererTestTimeoutMs = 15_000;

let fixtureRows: AgentComponent[] = [];
let fixtureDetail: AgentComponentDetail | null = null;
let listCalls = 0;
let detailCalls = 0;

const emitDbChange = (payload: DbChangePayload = {}) => {
  for (const cb of [...dbChangeSubscribers]) {
    cb(payload);
  }
};

describe("Desktop Agents workspace live updates (ISS-6882)", {
  concurrent: false,
}, () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: "",
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    fixtureRows = [componentRow("agent::alpha", "Alpha Agent")];
    fixtureDetail = componentDetail("agent::alpha", "Alpha Agent");
    listCalls = 0;
    detailCalls = 0;
    dbChangeSubscribers.clear();
    installDesktopApi();
  });

  afterEach(() => {
    cleanup();
  });

  it(
    "refreshes the rendered component list after a local DB change",
    async () => {
      renderProbe(<ListProbe />);

      expect(await findText("Alpha Agent")).toBeDefined();
      await waitFor(() => {
        expect(listCalls).toBe(1);
      });

      // An import lands in the local component DB. The main process announces it
      // on `desktop:db:changed`, whose payload carries a SESSION id — never a
      // component identity. That is the only signal the renderer gets.
      fixtureRows = [
        componentRow("agent::alpha", "Alpha Agent"),
        componentRow("skill::beta", "Beta Skill"),
      ];
      act(() => {
        emitDbChange({ sessionId: "session-not-a-component-id" });
      });

      // The last-good row survives the background refetch (no skeleton wipe)…
      expect(screen.getByText("Alpha Agent")).toBeDefined();
      // …and the newly imported component appears with no manual refresh.
      expect(await findText("Beta Skill")).toBeDefined();
    },
    rendererTestTimeoutMs
  );

  it(
    "refreshes an open component detail after a local DB change",
    async () => {
      renderProbe(<DetailProbe />);

      expect(await findText("Alpha Agent")).toBeDefined();
      await waitFor(() => {
        expect(detailCalls).toBe(1);
      });

      // A rescan rewrites the row behind the open detail. The db-change payload
      // still carries only a session id: a bridge that trusted it as a
      // `componentId` would scope the invalidation to a detail key nothing is
      // registered under, and this detail would stay on "Alpha Agent" forever.
      fixtureDetail = componentDetail(
        "agent::alpha",
        "Alpha Agent (rescanned)"
      );
      act(() => {
        emitDbChange({ sessionId: "session-not-a-component-id" });
      });

      expect(await findText("Alpha Agent (rescanned)")).toBeDefined();
      await waitFor(() => {
        expect(detailCalls).toBe(2);
      });
    },
    rendererTestTimeoutMs
  );

  it(
    "clears the rendered population when the last component is uninstalled",
    async () => {
      renderProbe(<ListProbe />);

      expect(await findText("Alpha Agent")).toBeDefined();

      fixtureRows = [];
      act(() => {
        emitDbChange({ sessionId: "session-not-a-component-id" });
      });

      await waitFor(
        () => {
          expect(screen.queryByText("Alpha Agent")).toBeNull();
        },
        { timeout: rendererTextTimeoutMs }
      );
      expect(screen.getByTestId("rows").textContent).toBe("");
    },
    rendererTestTimeoutMs
  );
});

function ListProbe() {
  const { data } = useAgentComponents({ limit: 500 });
  return (
    <div data-testid="rows">
      {(data?.items ?? []).map((row) => (
        <span key={row.slug}>{row.name}</span>
      ))}
    </div>
  );
}

function DetailProbe() {
  const { data } = useAgentComponentDetail("agent::alpha");
  return <div data-testid="detail">{data?.name ?? ""}</div>;
}

function renderProbe(probe: React.ReactNode) {
  return render(<DesktopAppCoreProvider>{probe}</DesktopAppCoreProvider>);
}

function findText(text: string) {
  return screen.findByText(text, undefined, {
    timeout: rendererTextTimeoutMs,
  });
}

function installDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getAgentComponentDetail: vi.fn(() => {
          detailCalls += 1;
          return Promise.resolve(fixtureDetail);
        }),
        listAgentComponents: vi.fn(() => {
          listCalls += 1;
          return Promise.resolve({
            items: [...fixtureRows],
            total: fixtureRows.length,
            hasMore: false,
          } satisfies AgentComponentListResponse);
        }),
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getAgentMonitorUrl: vi.fn(() => new Promise(() => undefined)),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      onDbChanged: vi.fn((cb: (payload: DbChangePayload) => void) => {
        dbChangeSubscribers.add(cb);
        return () => {
          dbChangeSubscribers.delete(cb);
        };
      }),
    },
  });
}

function componentRow(slug: string, name: string): AgentComponent {
  return makeComponent({ id: `uuid-for-${slug}`, name, slug });
}

function componentDetail(slug: string, name: string): AgentComponentDetail {
  return makeDetail({ id: `uuid-for-${slug}`, name, slug });
}
