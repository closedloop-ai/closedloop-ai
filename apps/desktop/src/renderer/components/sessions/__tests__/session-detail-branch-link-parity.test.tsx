/**
 * @file session-detail-branch-link-parity.test.tsx
 * @description ISS-5567: the Branch row of the shared session-detail Properties
 * pane, exercised through BOTH shells' adapters.
 *
 * The pane is one component
 * (`packages/app/agents/components/detail/agent-session-detail-view.tsx`) whose
 * link gate is `session.branch && session.branchArtifactId && getBranchHref`.
 * Desktop supplied the builder but never the id, so the same session linked on
 * web and rendered inert mono text on desktop.
 *
 * What this file actually pins, and what it does NOT:
 *  - It drives the REAL desktop wrapper (`SessionDetailView`), so the desktop
 *    href under assertion is the one the shipped shell builds, and it is
 *    round-tripped through `matchRoute` to prove it addresses the branch rather
 *    than merely looking like a URL.
 *  - The "web" side is the shared pane plus a builder matching the contract
 *    `apps/app`'s session-detail page passes. `apps/desktop` cannot import
 *    `apps/app`, so the REAL web builder is pinned by that page's own test
 *    (`apps/app/app/(authenticated)/[orgSlug]/sessions/[id]/__tests__/page.test.tsx`);
 *    this file is not coverage for it.
 *  - The cross-surface invariant it can genuinely fail on is AGREEMENT at both
 *    poles: with a route id both shells link, and without one both go inert. The
 *    second pole is the load-bearing half — a relaxed shared gate (dropping the
 *    `branchArtifactId` term) would let the WEB render a link with no
 *    destination while desktop looks unchanged.
 *  - Resolver correctness — where the desktop id comes from and when it is
 *    withheld — is NOT covered here; the payload is supplied by the IPC stub.
 *    That burden is carried by `apps/desktop/test/session-detail-branch-route.test.ts`.
 */
import { AgentSessionState } from "@repo/api/src/types/agent-session";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { ReadSource } from "@repo/api/src/types/read-source";
import { AgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { NavReferrerSurface } from "@repo/app/shared/lib/nav-referrer";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { matchRoute } from "../../../navigation/route-table";
import { drainedReadiness } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  DesktopAppCoreProvider,
  useDesktopAppCoreMode,
} from "../../../shared-agent-sessions/desktop-app-core-provider";
import type { DesktopAuthState } from "../../../types/desktop-api";
import { SessionDetailView } from "../SessionDetailView";
import { SessionReadSourceTopbarAction } from "../session-read-source-topbar-action";
import { sessionDetail } from "./fixtures/session-detail-fixture";

const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));

const originalOnLine = Object.getOwnPropertyDescriptor(
  window.navigator,
  "onLine"
);

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

const SESSION_ID = "branch-link-session";
const REPO_FULL_NAME = "closedloop-ai/symphony-alpha";
const BRANCH_NAME = "feat/fea-1943-session-details-local-data";
const ORG_SLUG = "closedloop-ai";
/** The desktop main process's route id for this branch (`session-branch-route.ts`). */
const DESKTOP_BRANCH_ID = encodeBranchId({
  repoFullName: REPO_FULL_NAME,
  branchName: BRANCH_NAME,
});
/** The cloud projection's route id for the same branch — a Branch artifact uuid. */
const CLOUD_BRANCH_ARTIFACT_ID = "019fddd3-0fcc-713a-8f76-a770fdfdb947";

/** The shared pane labels the row "Branch"; find it by its own label, not by position. */
const BRANCH_ROW_LABEL = /^branch$/i;
/** The shared pane's settled not-found state (`SessionDetailNotFound`). */
const SESSION_NOT_FOUND_TEXT = /session not found/i;

function branchLinkSession(branchArtifactId?: string) {
  return sessionDetail({
    id: SESSION_ID,
    name: "Branch Link Session",
    overrides: {
      branch: BRANCH_NAME,
      ...(branchArtifactId ? { branchArtifactId } : {}),
    },
    state: AgentSessionState.Running,
    status: "active",
  });
}

function installDesktopApi(branchArtifactId?: string) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(async () => null),
        detail: vi.fn(async () => branchLinkSession(branchArtifactId)),
        list: vi.fn(async () => ({ items: [], total: 0 })),
        usage: vi.fn(async () => null),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      traceCommentsApi: {
        create: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(async () => []),
        reply: vi.fn(),
        update: vi.fn(),
      },
    },
  });
}

/**
 * The same authenticated-offline split, but with the auth read held OPEN so the
 * pending window is observable. Without this the auth promise resolves during the
 * very first `await` the query helper performs, and a test can only ever see the
 * settled state — which is how a link that paints and then vanishes slips through.
 */
function installDeferredAuthenticatedOffline(): {
  settle: () => Promise<void>;
} {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(window.desktopApi, {
    getDesktopAuthState: vi.fn(() =>
      gate.then(() => ({
        organizationId: "org-1",
        status: DesktopAuthStatus.Authenticated,
        userId: "user-1",
      }))
    ),
  });
  return {
    settle: async () => {
      release?.();
      await act(async () => {
        await gate;
      });
    },
  };
}

/**
 * The surviving ISS-5567 source split, post-ISS-5714: online, drained, and
 * authenticated WITHOUT an organization id.
 *
 * The two surfaces answer to different identity rules and that is deliberate —
 * see `CloudReadCutoverDecision.cloudHoldsHistory`. `resolveCloudReadCutover`
 * never looks at the organization, so Sessions cuts over to the cloud and the
 * detail it reads carries a cloud Branch ARTIFACT UUID.
 * `canonicalBranchesIdentityKey` does require one, so `/branches/:id` is still
 * served by the LOCAL source, which decodes `encodeBranchId` composites and
 * would find nothing under a uuid. The gate must withhold the builder.
 *
 * The session payload therefore comes over the cloud transport here, not the IPC
 * stub: reading it locally would mint the other source's id and test nothing.
 */
function installCloudSessionRead() {
  Object.assign(window.desktopApi, {
    cloudApiFetch: vi.fn(() =>
      Promise.resolve({
        kind: "response" as const,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "application/json"]] as [string, string][],
        bodyText: JSON.stringify({
          success: true,
          data: branchLinkSession(CLOUD_BRANCH_ARTIFACT_ID),
        }),
      })
    ),
    getCloudReadReadiness: vi.fn(() => Promise.resolve(drainedReadiness())),
    getDesktopAuthState: vi.fn(() =>
      Promise.resolve({
        organizationId: null,
        status: DesktopAuthStatus.Authenticated,
        userId: "user-1",
      })
    ),
  });
}

/**
 * A LIVE auth bridge, signed out but flippable — plus the drained readiness the
 * cutover requires — so a test can move the app-core mode Local → Cloud on a
 * mounted tree. `installDesktopApi` alone omits `getDesktopAuthState`, which
 * makes the store settle to a bridge-absent signed-out snapshot that can never
 * change.
 */
function installFlippableAuth(): { signIn: () => Promise<void> } {
  let push: ((next: DesktopAuthState) => void) | undefined;
  let current: DesktopAuthState = {
    organizationId: null,
    status: DesktopAuthStatus.SignedOut,
    userId: null,
  };
  Object.assign(window.desktopApi, {
    getCloudReadReadiness: vi.fn(() => Promise.resolve(drainedReadiness())),
    getDesktopAuthState: vi.fn(() => Promise.resolve(current)),
    onDesktopAuthStateChanged: (onChange: (next: DesktopAuthState) => void) => {
      push = onChange;
      return () => {
        push = undefined;
      };
    },
  });
  return {
    signIn: async () => {
      current = {
        organizationId: "org-1",
        status: DesktopAuthStatus.Authenticated,
        userId: "user-1",
      };
      await act(async () => {
        push?.(current);
        await Promise.resolve();
      });
    },
  };
}

function withProviders(ui: React.ReactElement) {
  return (
    <DesktopAppCoreProvider>
      <NavigationProvider
        adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
      >
        {ui}
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

/**
 * Open the Properties pane. The pane starts collapsed on both shells and the
 * control TOGGLES, so this only clicks when the pane is not already open —
 * otherwise a poll that calls it repeatedly would close the pane it is watching.
 */
async function openProperties(): Promise<void> {
  if (screen.queryByText(BRANCH_ROW_LABEL)) {
    return;
  }
  fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
  await screen.findByText(BRANCH_ROW_LABEL);
}

/** The Branch row's href, or null when the row rendered as plain text. */
async function branchRowHref(): Promise<string | null> {
  await openProperties();
  const row = screen.getByText(BRANCH_ROW_LABEL).closest("div");
  if (!row) {
    throw new Error("Branch row not found");
  }
  const link = within(row).queryByRole("link");
  return link ? link.getAttribute("href") : null;
}

/** The shared pane driven by the builder contract `apps/app`'s detail page passes. */
function renderWebShell(branchArtifactId?: string) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        getBranchHref={(id) =>
          `/${ORG_SLUG}/branches/${id}?from=${NavReferrerSurface.Session}`
        }
        isLoading={false}
        session={branchLinkSession(branchArtifactId)}
      />
    )
  );
}

function renderDesktopShell() {
  return render(
    withProviders(
      <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
    )
  );
}

/**
 * Reports the LIVE app-core mode from inside the provider, so a test asserting
 * behavior "after the cutover" can prove the cutover actually happened rather
 * than passing because the mode never moved and some other gate closed.
 */
function AppCoreModeProbe() {
  return <span data-testid="app-core-mode">{useDesktopAppCoreMode()}</span>;
}

function renderDesktopShellWithModeProbe() {
  return render(
    withProviders(
      <>
        <AppCoreModeProbe />
        <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
      </>
    )
  );
}

describe("ISS-5567: the shared Branch-row link gate, through both shells", () => {
  beforeEach(() => {
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    // Both renders mount `DesktopAppCoreProvider`, which builds its data sources
    // off `window.desktopApi` — install it before the first render.
    installDesktopApi();
  });

  afterEach(() => {
    // Two different mechanisms pin connectivity here — a getter spy for the
    // fixed-offline fixture, `Object.defineProperty` for the one that has to
    // CHANGE mid-test — and only the first is a mock. Restore the property
    // descriptor as well, or a pinned-offline navigator leaks into every test
    // that follows and they pass (or fail) for the wrong reason.
    vi.restoreAllMocks();
    if (originalOnLine) {
      Object.defineProperty(window.navigator, "onLine", originalOnLine);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  });

  it("links the Branch row on both shells when the session carries a route id", async () => {
    const web = renderWebShell(CLOUD_BRANCH_ARTIFACT_ID);
    const webHref = await branchRowHref();
    web.unmount();

    // The real desktop wrapper, fed the id the desktop detail read now resolves.
    // Before ISS-5567 the payload carried none, so this row was inert text while
    // the web row above was already a link.
    installDesktopApi(DESKTOP_BRANCH_ID);
    renderDesktopShell();
    // The link is withheld until the auth read settles (it must never appear and
    // then retract), so wait for it to arrive rather than sampling first paint.
    await waitFor(async () => expect(await branchRowHref()).not.toBeNull(), {
      timeout: 5000,
    });
    const desktopHref = await branchRowHref();

    expect({ desktop: desktopHref, web: webHref }).toEqual({
      desktop: `/branches/${encodeURIComponent(DESKTOP_BRANCH_ID)}?from=${NavReferrerSurface.Session}`,
      web: `/${ORG_SLUG}/branches/${CLOUD_BRANCH_ARTIFACT_ID}?from=${NavReferrerSurface.Session}`,
    });

    // Once offered, the link must STAY: the regression this guards is a link that
    // paints, then silently reverts to text when the auth read settles — which
    // unmounts a focused anchor out from under the keyboard.
    const link = within(
      screen.getByText(BRANCH_ROW_LABEL).closest("div") as HTMLElement
    ).getByRole("link");
    link.focus();
    expect(document.activeElement).toBe(link);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await branchRowHref()).toBe(desktopHref);
    expect(document.activeElement).toBe(link);

    // The desktop href is a real destination, not a URL-shaped string: the
    // desktop router must resolve it back to this branch's detail.
    expect(matchRoute(desktopHref?.split("?")[0] ?? "")).toEqual({
      branchId: DESKTOP_BRANCH_ID,
      kind: "branch-detail",
      params: { id: DESKTOP_BRANCH_ID },
    });
  });

  it("goes inert on both shells when the session carries no route id", async () => {
    // The load-bearing pole: a shared gate that dropped its `branchArtifactId`
    // term would let the WEB render a link to nowhere while desktop looks fine.
    const web = renderWebShell();
    expect(await branchRowHref()).toBeNull();
    expect(screen.getByText(BRANCH_NAME)).toBeDefined();
    web.unmount();

    renderDesktopShell();
    expect(await branchRowHref()).toBeNull();
    expect(screen.getByText(BRANCH_NAME)).toBeDefined();
  });

  it("never paints the link before the source split is known", async () => {
    // THE REGRESSION THIS EXISTS FOR: both source predicates read `false` from an
    // UNSETTLED auth state, so they agree VACUOUSLY while the auth IPC is in
    // flight. Without the settled-check the row paints as a link in that window
    // and then reverts to text a tick later — unmounting a focused anchor with
    // nothing else on the pane moving.
    //
    // The auth read is held open deliberately: resolved eagerly it settles inside
    // the first `await` any query helper performs, so the pending window would be
    // unobservable and this test would pass with or without the fix.
    installDesktopApi(DESKTOP_BRANCH_ID);
    const auth = installDeferredAuthenticatedOffline();

    renderDesktopShell();
    await openProperties();

    // Auth is still pending here.
    expect(await branchRowHref()).toBeNull();

    await auth.settle();

    // ISS-5714 changed what this settles INTO, and deliberately: an
    // authenticated-but-offline reader that never cut over now has BOTH surfaces
    // on the local database (the cloud has not been established as holding this
    // machine's history, and its Branch cache is cold), so the two agree and the
    // local composite id is a live destination. The invariant this case owns is
    // unchanged and is asserted on the transition itself: the row went text →
    // link, never link → text. A link that appears is a link the user can use; a
    // link that VANISHES takes focus with it.
    await waitFor(async () => expect(await branchRowHref()).not.toBeNull(), {
      timeout: 5000,
    });
    const settledHref = await branchRowHref();
    expect(settledHref).toBe(
      `/branches/${encodeURIComponent(DESKTOP_BRANCH_ID)}?from=${NavReferrerSurface.Session}`
    );
    // And it STAYS. Poll rather than sampling once, so a late retraction cannot
    // slip through between assertions.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(await branchRowHref()).toBe(settledHref);
    }
    expect(screen.getByText(BRANCH_NAME)).toBeDefined();
  });

  it("does not carry the previous mode's href across a read-source cutover", async () => {
    // Stage review on #4650. The source-split gate compares the two SELECTORS,
    // but what has to agree is who MINTED the id sitting in the query cache right
    // now. Those are the same value only because `useDesktopAppCoreStack` builds
    // a NEW QueryClient on every mode change, dropping the previous mode's cached
    // payload — so a flipped mode renders loading rather than a stale record with
    // the other producer's id. That invariant is implicit and load-bearing:
    // preserve the cache across a flip (a shared client, a hydration path, a
    // scope-keyed single client) and this pane would carry a LOCAL composite id
    // while `/branches/:id` is served by the CLOUD, with both selectors now
    // agreeing that cloud is the source — the exact dead link the gate exists to
    // prevent, and one the gate cannot see.
    installDesktopApi(DESKTOP_BRANCH_ID);
    const auth = installFlippableAuth();

    renderDesktopShellWithModeProbe();
    // Signed out and online: Sessions reads local, Branches reads local, so the
    // local composite id is minted and painted.
    await waitFor(async () => expect(await branchRowHref()).not.toBeNull(), {
      timeout: 5000,
    });
    const localModeHref = await branchRowHref();
    expect(localModeHref).toBe(
      `/branches/${encodeURIComponent(DESKTOP_BRANCH_ID)}?from=${NavReferrerSurface.Session}`
    );

    // Authenticated + online + drained → the cutover moves the reader to the
    // cloud. Both selectors now say cloud, so the gate alone would permit a link.
    await auth.signIn();
    // Prove the cutover landed — otherwise the assertion below could pass because
    // the mode never moved and the source-split gate closed instead, which is a
    // different invariant with different coverage.
    await waitFor(() =>
      expect(screen.getByTestId("app-core-mode").textContent).toBe(
        DesktopAppCoreMode.Cloud
      )
    );

    // The local id must not survive the flip, at any point after it. Poll rather
    // than sampling once: a preserved cache would keep rendering the stale anchor
    // steadily, and a single post-flip read could land in a loading frame and
    // pass for the wrong reason.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(document.querySelector(`a[href="${localModeHref}"]`)).toBeNull();
    }
  });

  it("withholds the desktop link when Branches would read a different source", async () => {
    // A local composite id names nothing in the CLOUD branch read, so a link
    // built here would land on "not found".
    //
    // ISS-5714 moved WHERE that split lives, and this case moved with it. Bare
    // authenticated-but-offline is no longer a split: both surfaces now stay
    // local until the cutover establishes that the cloud holds this machine's
    // history, and a local id read beside a local Branches source is a live
    // link. The axis that still diverges is IDENTITY COMPLETENESS — see
    // `installCloudSessionRead` — and it is the mirror image of the old case:
    // Sessions is on the cloud and mints a Branch artifact uuid, while
    // `/branches/:id` is still served locally and would find nothing under it.
    //
    // Both halves render the same Branch on the same pane and only the source
    // state differs, so the inert half cannot pass for the unrelated reason that
    // the fixture simply never links. The first half proves it does.
    installDesktopApi(DESKTOP_BRANCH_ID);
    const agreed = renderDesktopShell();
    await waitFor(async () => expect(await branchRowHref()).not.toBeNull(), {
      timeout: 5000,
    });
    agreed.unmount();

    installCloudSessionRead();
    render(
      withProviders(
        <>
          <AppCoreModeProbe />
          <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
        </>
      )
    );
    // Prove the CLOUD read is the one in play — otherwise the inert row below
    // could pass because the session never loaded at all, which is a different
    // (and vacuous) reason to find no link.
    await waitFor(() =>
      expect(screen.getByTestId("app-core-mode").textContent).toBe(
        DesktopAppCoreMode.Cloud
      )
    );

    // `branchRowHref` opens the (collapsed) Properties pane and THROWS if the
    // Branch row is absent, so this cannot pass on a pane that never rendered.
    await waitFor(async () => expect(await branchRowHref()).toBeNull(), {
      timeout: 5000,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(await branchRowHref()).toBeNull();
    }
    expect(screen.getByText(BRANCH_NAME)).toBeDefined();
  });
});

/**
 * The desktop shell with the ISS-5607 Labs gate resolved.
 *
 * Renders the REAL Topbar action beside the REAL detail pane, which is the
 * shipped arrangement: the badge lives in the Topbar's `actions` slot (App.tsx)
 * and reads the same `useAgentSessionDetail` cache entry the pane below renders,
 * so it never issues a second request and can never disagree with the pane about
 * whether a row exists.
 *
 * The flag adapter is mounted BELOW `DesktopAppCoreProvider` on purpose: that
 * provider mounts its own `FeatureFlagAdapterProvider` with a flags-off static
 * adapter, so an outer one would be shadowed. React resolves to the nearest
 * ancestor, so wrapping the subtree is what the gate actually reads.
 */
function renderDesktopShellWithReadSourceFlag(enabled: boolean) {
  return render(
    withProviders(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: enabled
            ? [DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY]
            : [],
        })}
      >
        <AppCoreModeProbe />
        <SessionReadSourceTopbarAction sessionId={SESSION_ID} />
        <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
      </FeatureFlagAdapterProvider>
    )
  );
}

/** The Topbar action WITHOUT the pane, to isolate what it reads on its own. */
function renderReadSourceActionAlone() {
  return render(
    withProviders(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY],
        })}
      >
        <SessionReadSourceTopbarAction sessionId={SESSION_ID} />
      </FeatureFlagAdapterProvider>
    )
  );
}

describe("ISS-5607: the session-detail read-source badge", () => {
  beforeEach(() => {
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    installDesktopApi(DESKTOP_BRANCH_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalOnLine) {
      Object.defineProperty(window.navigator, "onLine", originalOnLine);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  });

  it("names the store the pane read, and stays dark with the flag off", async () => {
    // Signed out and online, so the pane reads this machine's SQLite. The badge
    // has to say LOCAL: reporting the mode's other value here would tell a user
    // their data came from a workspace this render never touched.
    const gated = renderDesktopShellWithReadSourceFlag(true);
    const badge = await screen.findByTestId("read-source-badge");
    expect(badge.getAttribute("data-read-source")).toBe(ReadSource.Local);
    expect(badge.textContent).toBe("Local");
    gated.unmount();

    // Closed-by-default (ISS-4779): with the Labs toggle off the pane renders
    // exactly as it shipped. `openProperties` throws if the pane never rendered,
    // so this cannot pass for the vacuous reason that nothing mounted.
    renderDesktopShellWithReadSourceFlag(false);
    await openProperties();
    expect(screen.getByText(BRANCH_NAME)).toBeDefined();
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });

  it("claims no source over a session that was never read", async () => {
    // Both critics on #4650's successor caught this: the badge derives from the
    // app-core MODE, which is always answerable, so an ungated mount asserts
    // "Showing the data stored on this device" above the shared pane's
    // "Session not found". Which store WOULD serve this is not the same claim as
    // where these rows came from, and the second one is simply false when there
    // are no rows. `ReadSourceBadge` already treats an unattributable source as
    // render-nothing; this keeps the mount honest to that contract.
    Object.assign(window.desktopApi.agentSessionsApi, {
      detail: vi.fn(() => Promise.resolve(null)),
    });

    renderDesktopShellWithReadSourceFlag(true);

    // The pane settles on its not-found state — proving the read completed and
    // this is not merely a race against a still-pending badge.
    await screen.findByText(SESSION_NOT_FOUND_TEXT);
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });

  it("observes the pane's read without issuing one of its own", () => {
    // wongk cid 3776137731. The badge mounts in the Topbar, OUTSIDE the lazy
    // detail boundary, so an ENABLED observer here would be the one that opens
    // the detail read — and the desktop `details()` key defaults carry a 5 s
    // `refetchInterval` plus `refetchOnMount: "always"`, both per-observer, so a
    // second enabled observer means a second poll timer and a second forced
    // read. Rendered alone with the flag ON, it must therefore stay silent AND
    // dark: no IPC read, and nothing claimed about a source no read produced.
    // `render` flushes effects inside `act`, and an ENABLED observer starts its
    // fetch in the subscribe effect — so the read, if there were one, has
    // already been issued by the time this returns. No timing window is being
    // relied on to prove the absence.
    renderReadSourceActionAlone();

    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });
});
