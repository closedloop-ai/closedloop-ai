import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY } from "../../shared/feature-flags";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../shared/feature-flags-labs-detail";
import { DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY } from "../../shared/feature-flags-labs-surfaces";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../navigation/detail-title-context";
import { renderDesktopApp, setupAppShellSuite } from "./app-shell-harness";

/**
 * ISS-5574 (whitlockk review on #4661): the desktop tab title END TO END, through
 * the real `AppShell` wiring.
 *
 * `use-desktop-document-title.test.ts` covers `resolveDesktopDocumentTitle` in
 * isolation, which leaves the seam that actually ships untested: the `AppShell`
 * call site that feeds it `routeNavId`, the live detail ids, and the published
 * detail name, and the shared `useDocumentTitle` that writes the DOM. Disconnect
 * the hook from `App.tsx` and that unit suite stays green. This one goes red.
 *
 * So these cases drive real hash navigations and assert the real
 * `document.title` — flag off and on, list and detail, the record's name
 * arriving after the generic, and the agent-detail route that must NOT be
 * retitled (the sticky-navId hazard, which is only observable from here).
 *
 * Same technique as `detail-route-loading-state.test.tsx`: heavy chrome and the
 * lazy route chunks are mocked to markers, so the shell's own routing and title
 * wiring is exercised without standing up the provider stack.
 */

/** The title the desktop entry HTML sets; the pre-ISS-5574 behavior. */
const ENTRY_HTML_TITLE = "Closedloop";
const SESSION_ID = "s-1";
const BRANCH_ID = "b-1";
const AGENT_SLUG = "code-cassandra";

// Which flag keys read as ON. The test body seeds it from the real exported
// constants, so a flag rename cannot leave this suite asserting a dead string.
const flagControls = vi.hoisted(() => ({ enabled: new Set<string>() }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => flagControls.enabled.has(key),
  useFeatureFlagEnabledOptional: (key: string) => flagControls.enabled.has(key),
}));

// The name the mocked session/branch detail publishes to the shell, exactly as
// the real detail views publish their loaded record's name. `null` stands for an
// unresolved read (loading, not found, or genuinely nameless).
const detailControls = vi.hoisted(() => ({ title: null as string | null }));

vi.mock("../components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("../components/desktop-session-expired-banner", () => ({
  DesktopSessionExpiredBanner: () => null,
}));
vi.mock("../components/desktop-sync-prompt", () => ({
  DesktopSyncPrompt: () => null,
}));
vi.mock("../components/opt-in-distributions-banner", () => ({
  OptInDistributionsBanner: () => null,
}));
vi.mock("../components/command-palette/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-marker" />,
}));
vi.mock("../components/layout/Topbar", () => ({
  Topbar: () => <div data-testid="topbar-marker" />,
}));
vi.mock("../components/layout/mac-window-controls-underlay", () => ({
  MacWindowControlsUnderlay: () => null,
}));

vi.mock("../components/sessions/SessionsView", () => ({
  SessionsView: () => <div data-testid="sessions-list-marker" />,
}));
vi.mock("../components/branches/branches-view", () => ({
  BranchesView: () => <div data-testid="branches-list-marker" />,
}));
vi.mock("../components/sessions/SessionDetailView", () => ({
  SessionDetailView: ({ sessionId }: { sessionId: string }) => {
    usePublishDetailTitle(
      detailTitleKey("session", sessionId),
      detailControls.title,
      true
    );
    return <div data-testid="session-detail-marker" />;
  },
}));
vi.mock("../components/branches/branch-detail-view", () => ({
  BranchDetailView: ({ branchId }: { branchId: string }) => {
    usePublishDetailTitle(
      detailTitleKey("branch", branchId),
      detailControls.title,
      true
    );
    return <div data-testid="branch-detail-marker" />;
  },
}));
vi.mock("../components/agents/agents-view", () => ({
  AgentsView: () => <div data-testid="agents-list-marker" />,
}));
vi.mock("../components/agents/agent-detail-view", () => ({
  AgentDetailView: () => <div data-testid="agent-detail-marker" />,
}));

describe("ISS-5574: the desktop shell's window title", () => {
  // ISS-8118: adopt the shared harness for timeout budgets and lifecycle —
  // asyncUtilTimeout (15 s) < testTimeout (30 s), matchMedia, ResizeObserver,
  // localStorage, desktopApi, and afterEach cleanup.
  setupAppShellSuite();

  beforeEach(() => {
    document.title = ENTRY_HTML_TITLE;
    detailControls.title = null;
    flagControls.enabled.clear();
    // Labs container + the per-item Agents gate: both ON so the Branches and
    // Agents DESTINATIONS render rather than answering with the "turned off"
    // panel. Neither has anything to do with the title; they just make the
    // routes reachable. The title flag stays OFF until a case opts in.
    flagControls.enabled.add(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
    flagControls.enabled.add(DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY);
  });

  afterEach(() => {
    // Unmount BEFORE resetting. Vitest runs `afterEach` in reverse
    // registration order, so this hook precedes the harness teardown, and
    // `useDocumentTitle` restores each shell's captured previous title as it
    // unmounts — a reset that ran first would be undone by that restore and
    // leave a detail title behind. `cleanup()` is idempotent, so the harness
    // teardown's own call stays a no-op.
    cleanup();
    document.title = ENTRY_HTML_TITLE;
  });

  it("leaves the window title alone with the flag off", async () => {
    await renderShell("#/sessions");

    expect(document.title).toBe(ENTRY_HTML_TITLE);
  });

  it("names each list surface with the flag on", async () => {
    enableTabTitles();

    await renderShell("#/sessions");
    expect(document.title).toBe("Sessions | Closedloop.ai");

    await navigateHash("#/branches");
    await waitFor(() =>
      expect(document.title).toBe("Branches | Closedloop.ai")
    );
  });

  it("names a session detail after its record, not after its section", async () => {
    enableTabTitles();

    // Unresolved read first: the honest generic, never a placeholder that would
    // read as the record's name — and never "Sessions", which is what a
    // nav-id-first resolution would have produced for every open detail.
    await renderShell(`#/sessions/${SESSION_ID}`);
    await waitFor(() => expect(document.title).toBe("Session | Closedloop.ai"));

    // …then the record itself, once the detail publishes its name.
    detailControls.title = "Nightly regression sweep";
    await renderShell(`#/sessions/${SESSION_ID}`);
    await waitFor(() =>
      expect(document.title).toBe("Nightly regression sweep | Closedloop.ai")
    );
  });

  it("names a branch detail after its record", async () => {
    enableTabTitles();
    detailControls.title = "feature/web-branches";

    await renderShell(`#/branches/${BRANCH_ID}`);

    await waitFor(() =>
      expect(document.title).toBe("feature/web-branches | Closedloop.ai")
    );
  });

  // The regression this suite exists for. `#/agents/<slug>` matches as
  // `agent-detail`, so it has no nav id of its own and borrows the shell's
  // sticky one. Resolving the list arm off that sticky id titled an agent-detail
  // window after a section the user had left, against an "Agents / <name>"
  // breadcrumb. Only reachable from the shell: the resolver alone cannot show it.
  it("does not retitle an agent detail opened directly, with no Sessions in history", async () => {
    enableTabTitles();

    await renderShell(`#/agents/${AGENT_SLUG}`);

    expect(document.title).toBe(ENTRY_HTML_TITLE);
  });

  /**
   * The case above can no longer fail on its own, and this one is why it is
   * still here.
   *
   * A direct `#/agents/<slug>` load borrows `DEFAULT_NAV_ID`, and that is now
   * Dashboard — a surface ISS-5574 does not title. So the sticky-id bug and the
   * fix produce the SAME entry-HTML title there, and the assertion above passes
   * either way. Reaching the agent detail FROM Sessions is what restores the
   * discrimination: the sticky id is then Sessions, which this feature DOES
   * title, so reading it would leave the window on "Sessions | Closedloop.ai"
   * while the breadcrumb read "Agents / <name>" — the original defect, now the
   * only arrangement that can still catch it.
   */
  it("does not retitle an agent detail reached from Sessions", async () => {
    enableTabTitles();

    await renderShell("#/sessions");
    expect(document.title).toBe("Sessions | Closedloop.ai");

    await navigateHash(`#/agents/${AGENT_SLUG}`);

    await waitFor(() => expect(document.title).toBe(ENTRY_HTML_TITLE));
  });

  it("hands the title back when a named surface is left for one it does not own", async () => {
    enableTabTitles();

    await renderShell("#/sessions");
    expect(document.title).toBe("Sessions | Closedloop.ai");

    await navigateHash("#/dashboard");

    await waitFor(() => expect(document.title).toBe(ENTRY_HTML_TITLE));
  });
});

function enableTabTitles(): void {
  flagControls.enabled.add(
    DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
}

// jsdom fires `hashchange` on a later tick and testing-library's `act` does not
// flush it deterministically; dispatch it explicitly so the desktop hash host's
// listener runs inside the current act() flush.
async function navigateHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
}

async function renderShell(initialHash: string): Promise<void> {
  renderDesktopApp(initialHash);
  await act(async () => {
    await Promise.resolve();
  });
}
