import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  type TranscriptSyncStatusSnapshot,
} from "../../../../shared/transcript-sync-status-contract";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";
import { sessionDetail } from "./fixtures/session-detail-fixture";

/**
 * @description ISS-7516 — the PRODUCTION WIRING, driven through the shipped
 * desktop shell.
 *
 * The decision is graded three other places: pure inputs
 * (`apps/desktop/test/transcript-never-expected.test.ts`), the hook's live
 * reads (`renderer/hooks/__tests__/use-transcript-never-expected.test.tsx`),
 * and the shared render
 * (`packages/app/.../__tests__/session-transcript-never-expected.test.tsx`).
 * All three would stay green if `SessionDetailView` stopped calling the hook,
 * stopped forwarding its result, or passed the WRONG session's compute-target
 * id — which is the one thing only this file can fail on.
 *
 * The two cases differ in exactly one input: the compute target the session
 * came from. The positive sibling is load-bearing, not decoration — without it,
 * a shell that hard-coded `true` would pass the first case.
 */

const SESSION_ID = "never-expected-wiring-session";
/** The fixture's own compute target — the machine this test's device claims to be. */
const THIS_DEVICE = "local-desktop";
const OTHER_DEVICE = "someone-elses-mac";
const NEVER_EXPECTED_TITLE = "Transcript stays on this machine";
const PENDING_TITLE = "Transcript still syncing";

const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function neverExpectedSession() {
  return sessionDetail({
    id: SESSION_ID,
    name: "Never Expected Session",
    overrides: {
      // A cloud-backed detail carries the FR8 availability summary, and
      // `missing` is what the server synthesizes when it holds no
      // `SessionTranscript` row at all — which is every session a
      // transcript-excluding machine produces.
      transcripts: [
        {
          fileKey: "main",
          availability: TranscriptAvailability.Missing,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ],
    },
    status: "active",
  });
}

function statusSnapshot(): TranscriptSyncStatusSnapshot {
  return {
    enabled: true,
    online: true,
    // A transcript-excluding level closes the lane, which is exactly the
    // machine this disclosure describes.
    tierGate: TranscriptEgressGate.Denied,
    storeReady: true,
    computeTargetId: THIS_DEVICE,
    statusCounts: emptyTranscriptStatusCounts(),
  };
}

function installDesktopApi(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(() => Promise.resolve(null)),
        detail: vi.fn(() => Promise.resolve(neverExpectedSession())),
        list: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
        transcript: vi.fn(() =>
          Promise.resolve({ sessionId: SESSION_ID, files: [] })
        ),
        usage: vi.fn(() => Promise.resolve(null)),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      // The shell reads the cloud in this configuration (authenticated, online,
      // a metadata level that still permits session metadata), so the detail
      // arrives over the cloud transport, not the IPC stub.
      cloudApiFetch: vi.fn(() =>
        Promise.resolve({
          kind: "response" as const,
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]] as [string, string][],
          bodyText: JSON.stringify({
            success: true,
            data: neverExpectedSession(),
          }),
        })
      ),
      getDesktopAuthState: vi.fn(() =>
        Promise.resolve({
          organizationId: "org-1",
          status: DesktopAuthStatus.Authenticated,
          userId: "user-1",
        })
      ),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      // The device's own answer: a level that keeps transcripts local.
      getSyncConsentRecord: vi.fn(() =>
        Promise.resolve({
          tier: "metadata",
          bound: true,
          organizationId: "org-1",
        })
      ),
      getTranscriptSyncStatus: vi.fn(() => Promise.resolve(statusSnapshot())),
    },
  });
}

function renderDesktopShell() {
  return render(
    <DesktopAppCoreProvider>
      {/*
       * INSIDE the app-core provider on purpose: that provider mounts its own
       * all-off static adapter for the slice above `App`, and in production
       * `DesktopFeatureFlagProvider` mounts inside it for every view. Wrapping
       * from outside would be silently overridden and this suite would assert
       * the flag-off path under a flag-on name.
       */}
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY],
        })}
      >
        <NavigationProvider
          adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
        >
          <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

beforeEach(() => {
  searchParamsMock.mockReturnValue(new URLSearchParams());
  installDesktopApi();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("SessionDetailView — never-expected transcript wiring (ISS-7516)", () => {
  it("renders the settled absence for a session recorded on this machine", async () => {
    renderDesktopShell();

    await waitFor(
      () => {
        expect(screen.getByText(NEVER_EXPECTED_TITLE)).toBeDefined();
      },
      { timeout: 10_000 }
    );
    expect(screen.queryByText(PENDING_TITLE)).toBeNull();
  }, 20_000);

  it("renders the not-yet-arrived state for a session recorded elsewhere", async () => {
    // Same shell, same flag, same missing transcript — only the machine the
    // session came from differs. This is what proves the shell forwards a
    // COMPUTED verdict for THIS session rather than a constant.
    Object.assign(window.desktopApi as object, {
      getTranscriptSyncStatus: vi.fn(() =>
        Promise.resolve({ ...statusSnapshot(), computeTargetId: OTHER_DEVICE })
      ),
    });
    renderDesktopShell();

    await waitFor(
      () => {
        expect(screen.getByText(PENDING_TITLE)).toBeDefined();
      },
      { timeout: 10_000 }
    );
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  }, 20_000);
});
