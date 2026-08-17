import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  TranscriptSyncStatus,
  type TranscriptSyncStatusSnapshot,
} from "../../../shared/transcript-sync-status-contract";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import { FirstLaunchImportBanner } from "../first-launch-import-banner";

// Same shape as the sibling banner suite: the splash's visibility is driven by
// the ingest + maintenance hooks, so mocking them makes each phase reachable
// without a live runtime.
const hooks = vi.hoisted(() => ({
  useIngestProgress: vi.fn(),
  useMaintenanceProgress: vi.fn(),
}));
vi.mock("../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  useMaintenanceProgress: hooks.useMaintenanceProgress,
}));

// The exact string three tickets were filed to remove, verbatim.
const LEGACY_COPY = "Computed on this device · 0 bytes uploaded";
// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const HARDCODED_BYTE_CLAIM = /0 bytes/;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function importingIngest(): IngestProgress {
  return {
    byHarness: [{ harness: "codex", total: 100, processed: 40 }],
    total: 100,
    processed: 40,
    preparing: false,
    complete: false,
    timedOut: false,
  };
}

function installDesktopApi(
  snapshot: TranscriptSyncStatusSnapshot | null
): ReturnType<typeof vi.fn> {
  const getTranscriptSyncStatus = vi.fn(() => Promise.resolve(snapshot));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: snapshot ? { getTranscriptSyncStatus } : {},
  });
  return getTranscriptSyncStatus;
}

/** Let the hook's first read settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  hooks.useIngestProgress.mockReturnValue(importingIngest());
  hooks.useMaintenanceProgress.mockReturnValue({ active: false, phase: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("import splash honest sync copy (ISS-4716, unflagged by ISS-5348)", () => {
  it("never renders a byte claim at shipped defaults", async () => {
    // THE regression test. On today's `main` this fails: the default config
    // renders "Computed on this device · 0 bytes uploaded".
    installDesktopApi({
      enabled: true,
      online: true,
      tierGate: TranscriptEgressGate.Allowed,
      storeReady: true,
      statusCounts: emptyTranscriptStatusCounts(),
    });

    render(<FirstLaunchImportBanner />);
    await settle();

    expect(document.body.textContent).not.toContain(LEGACY_COPY);
    expect(document.body.textContent).not.toMatch(HARDCODED_BYTE_CLAIM);
  });

  it("reads the real sync state at shipped defaults", async () => {
    // The Computing-phase copy is decided by `deriveImportSplashState`, so it is
    // asserted directly in `import-splash/__tests__/import-splash-state.test.ts`
    // rather than by driving this component's maintenance-bridge latch.
    const read = installDesktopApi({
      enabled: false,
      online: false,
      tierGate: TranscriptEgressGate.Denied,
      storeReady: false,
      statusCounts: emptyTranscriptStatusCounts(),
    });

    render(<FirstLaunchImportBanner />);
    await settle();

    expect(screen.getByText("You turned transcript upload off")).toBeTruthy();
    // The IPC read is now unconditional — it used to be suppressed on the
    // default path, which is why the real state never reached anyone.
    expect(read).toHaveBeenCalled();
  });

  it("keeps the background reassurance beside the footnote", async () => {
    // The footer's other span is a sibling of the sync line, not part of it —
    // replacing the footnote must not take it with it.
    installDesktopApi({
      enabled: true,
      online: true,
      tierGate: TranscriptEgressGate.Allowed,
      storeReady: true,
      statusCounts: emptyTranscriptStatusCounts(),
    });

    render(<FirstLaunchImportBanner />);
    await settle();

    expect(document.body.textContent).toContain("Runs in the background");
    expect(document.body.textContent).toContain(
      "Transcripts sync to your workspace"
    );
  });

  it("distinguishes a blocked lane from a working one instead of showing one string for both", async () => {
    // The original defect: a user whose uploads were blocked and a user who had
    // chosen local-only saw byte-identical copy.
    installDesktopApi({
      enabled: true,
      online: true,
      tierGate: TranscriptEgressGate.Allowed,
      storeReady: true,
      statusCounts: {
        ...emptyTranscriptStatusCounts(),
        [TranscriptSyncStatus.Dead]: 1,
      },
    });

    render(<FirstLaunchImportBanner />);
    await settle();

    expect(document.body.textContent).toContain(
      "Some transcripts couldn't be uploaded"
    );
  });

  it("renders no byte claim when mounted bare, with no provider and no props", () => {
    // The banner is mounted this way in many existing suites. It used to render
    // the legacy footer here because `honestCopy` defaulted to false; with the
    // flag gone there is no such default to fall back to.
    expect(() => render(<FirstLaunchImportBanner />)).not.toThrow();
    expect(document.body.textContent).not.toMatch(HARDCODED_BYTE_CLAIM);
  });
});
