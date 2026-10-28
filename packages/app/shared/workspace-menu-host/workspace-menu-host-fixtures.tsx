import {
  WorkspaceMenuHostId,
  type WorkspaceMenuProjection,
  WorkspaceMenuProjectionStatus,
  workspaceMenuCapabilityReady,
} from "@repo/api/src/types/workspace-menu";
import {
  buildDesktopWorkspaceMenuCapabilities,
  buildWebWorkspaceMenuCapabilities,
} from "./workspace-menu-capabilities";
import type { WorkspaceMenuHostAdapter } from "./workspace-menu-host-adapter";

/**
 * Adapters for tests and stories. Shared so the component's coverage and the
 * port's own coverage exercise the same shapes the real hosts produce — a
 * fixture that drifts from its adapter proves nothing about the adapter.
 */

export const WEB_WORKSPACE_MENU_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-universal.dmg";

/**
 * Declared as the READY member rather than the whole union: every consumer
 * spreads it to build another ready projection, and the union type made
 * `activeWorkspace` and `workspaces` unreachable on a value that always has
 * them.
 */
export const READY_WORKSPACE_MENU_PROJECTION: Extract<
  WorkspaceMenuProjection,
  { status: typeof WorkspaceMenuProjectionStatus.Ready }
> = {
  status: WorkspaceMenuProjectionStatus.Ready,
  activeWorkspace: {
    id: "org_active",
    name: "Closedloop",
    slug: "closedloop",
    imageUrl: null,
  },
  workspaces: [
    {
      id: "org_active",
      name: "Closedloop",
      slug: "closedloop",
      imageUrl: null,
    },
    { id: "org_other", name: "Acme", slug: "acme", imageUrl: null },
  ],
  actor: {
    name: "Ada Lovelace",
    email: "ada@closedloop.ai",
    imageUrl: null,
  },
  downloadUrl: WEB_WORKSPACE_MENU_DOWNLOAD_URL,
};

export function createWebWorkspaceMenuHostAdapterFixture(
  overrides: Partial<WorkspaceMenuHostAdapter> = {}
): WorkspaceMenuHostAdapter {
  return {
    host: WorkspaceMenuHostId.Web,
    useWorkspaceMenuProjection: () => READY_WORKSPACE_MENU_PROJECTION,
    useWorkspaceMenuCapabilities: () =>
      buildWebWorkspaceMenuCapabilities({
        download: workspaceMenuCapabilityReady(),
      }),
    switchWorkspace: () => Promise.resolve(),
    createWorkspaceSlot: <div data-testid="create-workspace-slot" />,
    signOut: () => Promise.resolve(),
    ...overrides,
  };
}

export function createDesktopWorkspaceMenuHostAdapterFixture(
  overrides: Partial<WorkspaceMenuHostAdapter> = {}
): WorkspaceMenuHostAdapter {
  return {
    host: WorkspaceMenuHostId.Desktop,
    useWorkspaceMenuProjection: () => ({
      ...READY_WORKSPACE_MENU_PROJECTION,
      // Desktop is single-org: one workspace, and no URL slug of its own.
      activeWorkspace: {
        id: "org_active",
        name: "Closedloop",
        slug: null,
        imageUrl: null,
      },
      workspaces: [
        { id: "org_active", name: "Closedloop", slug: null, imageUrl: null },
      ],
      downloadUrl: null,
    }),
    useWorkspaceMenuCapabilities: () =>
      buildDesktopWorkspaceMenuCapabilities({ isGuest: false }),
    diagnosticsHref: "/diagnostics",
    signOut: () => Promise.resolve(),
    ...overrides,
  };
}

export function createDesktopGuestWorkspaceMenuHostAdapterFixture(
  overrides: Partial<WorkspaceMenuHostAdapter> = {}
): WorkspaceMenuHostAdapter {
  return createDesktopWorkspaceMenuHostAdapterFixture({
    useWorkspaceMenuProjection: () => ({
      status: WorkspaceMenuProjectionStatus.Guest,
      downloadUrl: null,
    }),
    useWorkspaceMenuCapabilities: () =>
      buildDesktopWorkspaceMenuCapabilities({ isGuest: true }),
    requestAccount: () => undefined,
    ...overrides,
  });
}
