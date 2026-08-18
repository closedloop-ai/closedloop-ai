/**
 * FEA-4261 (cross-surface parity, wongk): the "impact since I changed it" payoff
 * on the agent-component detail Sessions tab must render on the Electron renderer
 * exactly as it does on the web app. `DetailSessionsTab` lives in the shared
 * `@repo/app` slice, so the version attribution is one implementation — but the
 * navigation port differs per surface (the renderer drives the hash-store
 * adapter, not the Next router).
 *
 * The shipped implementation surfaces per-session version impact as a trailing
 * "Version" column (`versionLabelBySession` → `Current` / `Rev N` / em-dash),
 * NOT as grouped section dividers. This mounts the REAL shared tab under the
 * desktop navigation adapter and asserts:
 *   1. the desktop navigation seam — a session-name link built from the real
 *      `desktopSessionDetailHref` helper renders a hash-prefixed anchor and a
 *      plain left-click navigates the internal path (the `#/…` shape the earlier
 *      revision used is a dead click the adapter's route guard drops, FEA-4051);
 *   2. the Version column renders the current + earlier revision labels when
 *      runs span ≥2 component versions, and no row is dropped;
 *   3. an unattributed session (no `usageSessions` entry) renders the em-dash
 *      "version unknown" cell rather than being omitted.
 *
 * JSDOM cannot compute layout, so this asserts on the rendered column text (and
 * that no row is dropped), not pixels.
 */

import type {
  AgentComponent,
  AgentComponentDetail,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { DetailSessionsTab } from "@repo/app/agents/components/workspace/detail-sessions-tab";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopNavigation,
  type DesktopHashHost,
  type DesktopNavigation,
} from "../../../navigation/desktop-adapter";
import { desktopSessionDetailHref } from "../../../shared-agent-sessions/session-hrefs";

const CURRENT_HASH = "hash-cur";
const OLDER_HASH = "hash-old";
const RE_SESSION_NAME = /^divider-session-\d+$/;
const CURRENT_VERSION_LABEL = "Current";
const OLDER_VERSION_LABEL = "Rev 1";
const UNATTRIBUTED_VERSION_CELL = "—";
// The agent-detail "Version" column renders as the shared table's trailing
// `extra` column, tagged `data-column-id="extra"` on each cell.
const VERSION_COLUMN_SELECTOR = '[data-column-id="extra"]';

const stubComponent: AgentComponent = {
  id: "component-1",
  slug: "subagent::version-divider",
  name: "Version Divider Agent",
  kind: AgentComponentKind.Subagent,
} as AgentComponent;

function makeSessions(count: number) {
  return Array.from({ length: count }, (_, i) =>
    createAgentSessionListItemFixture({
      id: `session-${i}`,
      name: `divider-session-${i}`,
    })
  );
}

function makeVersions(): ComponentVersion[] {
  return [
    {
      hash: CURRENT_HASH,
      source: "pack",
      format: "md",
      createdAt: "2026-02-01T00:00:00.000Z",
      isCurrent: true,
      content: "current body",
    },
    {
      hash: OLDER_HASH,
      source: "pack",
      format: "md",
      createdAt: "2026-01-01T00:00:00.000Z",
      isCurrent: false,
      content: "older body",
    },
  ];
}

function makeUsageSessions(
  count: number
): AgentComponentDetail["usageSessions"] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `session-${i}`,
    invocationCount: 1,
    versionHash: i % 2 === 0 ? CURRENT_HASH : OLDER_HASH,
  }));
}

// Minimal in-memory hash host so the desktop navigation adapter mounts without a
// real window.location.hash (mirrors the desktop-adapter unit test).
function createFakeHashHost(initialHash = ""): DesktopHashHost {
  let hash = initialHash;
  const listeners = new Set<() => void>();
  return {
    getHash: () => hash,
    setHash: (href) => {
      if (hash.slice(1) === href) {
        return;
      }
      hash = `#${href}`;
      for (const listener of listeners) {
        listener();
      }
    },
    onHashChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function renderOnDesktop(node: ReactNode, navigation: DesktopNavigation) {
  return render(
    <NavigationProvider adapter={navigation.adapter}>{node}</NavigationProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("agent-detail Sessions tab version impact — desktop renderer (FEA-4261)", () => {
  it("renders the Version column across revisions and navigates the desktop seam on a session-name click", () => {
    const navigation = createDesktopNavigation(
      createFakeHashHost("#/dashboard")
    );
    renderOnDesktop(
      <DetailSessionsTab
        component={stubComponent}
        getSessionHref={desktopSessionDetailHref}
        sessions={makeSessions(4)}
        usageSessions={makeUsageSessions(4)}
        versions={makeVersions()}
      />,
      navigation
    );

    // The Version column header renders when usage attribution + a version
    // history exist. `getByText` throws when absent, so a successful call is the
    // assertion (the desktop renderer vitest config does not load jest-dom's
    // `toBeInTheDocument`).
    expect(screen.getByText("Version")).toBeTruthy();
    // The current revision and the one earlier revision both surface a label.
    expect(screen.getAllByText(CURRENT_VERSION_LABEL).length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByText(OLDER_VERSION_LABEL).length).toBeGreaterThan(0);
    // No row dropped across the mixed-revision set.
    expect(screen.getAllByText(RE_SESSION_NAME)).toHaveLength(4);

    // Desktop navigation seam: the session-name link uses the real
    // `desktopSessionDetailHref` (unprefixed `/sessions/…`), so the port Link
    // renders a hash-prefixed anchor and a plain left-click navigates the
    // internal path through the adapter — the `#/…` shape the earlier revision
    // fed in would be a dead click the route guard drops.
    const firstRow = screen.getByText("divider-session-0");
    expect(firstRow.getAttribute("href")).toBe("#/sessions/session-0");
    fireEvent.click(firstRow);
    expect(navigation.getHref()).toBe("/sessions/session-0");
  });

  it("renders an em-dash Version cell for an unattributed session (version unknown)", () => {
    const navigation = createDesktopNavigation(
      createFakeHashHost("#/dashboard")
    );
    // session-0 is attributed to the current version; session-1 has NO usage
    // entry, so its version is unknown and the column must render the em-dash
    // rather than dropping the row.
    const usageSessions: AgentComponentDetail["usageSessions"] = [
      { sessionId: "session-0", invocationCount: 1, versionHash: CURRENT_HASH },
    ];
    const { container } = renderOnDesktop(
      <DetailSessionsTab
        component={stubComponent}
        getSessionHref={desktopSessionDetailHref}
        sessions={makeSessions(2)}
        usageSessions={usageSessions}
        versions={makeVersions()}
      />,
      navigation
    );

    // The column still renders (one attributed session), and both rows survive.
    expect(screen.getByText("Version")).toBeTruthy();
    expect(screen.getAllByText(RE_SESSION_NAME)).toHaveLength(2);
    // The Version-column body cells: session-0 shows "Current"; the
    // unattributed session-1 shows the em-dash "version unknown" cell rather
    // than being dropped. (The first `extra` cell is the header.)
    const versionCells = [
      ...container.querySelectorAll(VERSION_COLUMN_SELECTOR),
    ].map((cell) => cell.textContent);
    expect(versionCells).toContain(CURRENT_VERSION_LABEL);
    expect(versionCells).toContain(UNATTRIBUTED_VERSION_CELL);
  });

  it("omits the Version column entirely when no usage attribution exists", () => {
    const navigation = createDesktopNavigation(
      createFakeHashHost("#/dashboard")
    );
    renderOnDesktop(
      <DetailSessionsTab
        component={stubComponent}
        getSessionHref={desktopSessionDetailHref}
        sessions={makeSessions(3)}
        usageSessions={[]}
        versions={makeVersions()}
      />,
      navigation
    );

    expect(screen.queryByText("Version")).toBeNull();
    expect(screen.getAllByText(RE_SESSION_NAME)).toHaveLength(3);
  });
});
