/**
 * ISS-5489 (PLN-1694 M2): the Sessions landing's sync acknowledgement.
 *
 * The prototype drove this card off a 450ms timer, which always reaches 100%.
 * This one is driven by the real cloud-sync lane, so the cases that matter are
 * the ones a fixture cannot have: no measurement yet, a level that uploads
 * nothing, and a lane reporting items it could not deliver. What the card must
 * never do is print a number it did not observe.
 */

import { DataSyncLevelValue } from "@repo/app/shared/lib/data-sync-copy";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSyncProgress } from "../../../hooks/use-ingest-progress";
import {
  type SyncConsentArrival,
  SyncConsentArrivalProvider,
} from "../../onboarding/sync-consent-arrival";
import {
  SessionsSyncProgressBanner,
  SYNC_OFF_MESSAGE,
} from "../sessions-sync-progress-banner";

const WORKSPACE = "Acme Engineering";
const PROGRESS_ROLE = "progressbar";
/** Any x/y counter at all — what an unmeasured lane must not print. */
const ANY_COUNTER = /\d+ \/ \d+/;
const NOT_A_NUMBER = /NaN/;
const UNIDENTIFIED_BACKLOG = /99/;
const SYNCING_TITLE = /Syncing your sessions/;
const UNDELIVERABLE = /2 items could not be uploaded/;
const SYNCED_TITLE = /Sessions synced to/;
const ORG_ID = "org_acme";
const USER_ID = "user_1";

const stubs = vi.hoisted(() => ({
  progress: null as CloudSyncProgress | null,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useCloudSyncProgress: () => stubs.progress,
}));

function lane(overrides: Partial<CloudSyncProgress> = {}): CloudSyncProgress {
  return {
    backfilling: true,
    caughtUp: false,
    deadLetteredSessions: 0,
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    ...overrides,
  };
}

/** An answer committed by the signed-in identity, which is the only kind the gate publishes. */
function arrivalFor(
  level: SyncConsentArrival["level"],
  workspaceName: string | null = WORKSPACE
): SyncConsentArrival {
  return {
    level,
    organizationId: ORG_ID,
    userId: USER_ID,
    workspaceName,
  };
}

function bannerTree(arrival: SyncConsentArrival | null) {
  return (
    <SyncConsentArrivalProvider arrival={arrival}>
      <SessionsSyncProgressBanner />
    </SyncConsentArrivalProvider>
  );
}

function renderBanner(arrival: SyncConsentArrival | null) {
  return render(bannerTree(arrival));
}

afterEach(() => {
  cleanup();
  stubs.progress = null;
});

describe("SessionsSyncProgressBanner", () => {
  it("renders nothing on a launch that did not answer the consent question", () => {
    stubs.progress = lane({ pendingBackfillSessions: 12 });

    const { container } = renderBanner(null);

    expect(container.textContent).toBe("");
  });

  it("names the level the user chose, from the takeover's own copy", () => {
    stubs.progress = lane({ pendingBackfillSessions: 10 });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(
      screen.getByText(`Syncing your sessions to ${WORKSPACE}`)
    ).toBeDefined();
    expect(screen.getByText("Uploading full transcripts")).toBeDefined();
  });

  it("describes a metadata answer as metadata, not as transcripts", () => {
    stubs.progress = lane({ pendingBackfillSessions: 3 });

    renderBanner(arrivalFor(DataSyncLevelValue.Metadata));

    expect(screen.getByText("Uploading metadata only")).toBeDefined();
  });

  it("counts down the real backlog and reaches the completed state", () => {
    stubs.progress = lane({ pendingBackfillSessions: 10 });
    const { rerender } = renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.getByText("0 / 10")).toBeDefined();

    stubs.progress = lane({ caughtUp: true, pendingBackfillSessions: 0 });
    rerender(bannerTree(arrivalFor(DataSyncLevelValue.Full)));

    expect(screen.getByText(`Sessions synced to ${WORKSPACE}`)).toBeDefined();
    expect(screen.getByText("10 / 10")).toBeDefined();
  });

  it("stops counting when the lane stops reporting, instead of reading N / N", () => {
    // The peak survives; the measurement does not. Deriving `processed` from a
    // missing sample filled the bar and printed `10 / 10` under a title still
    // reading "Syncing" — a completed-looking card for a measurement nobody took.
    stubs.progress = lane({ pendingBackfillSessions: 10 });
    const { rerender } = renderBanner(arrivalFor(DataSyncLevelValue.Full));
    expect(screen.getByText("0 / 10")).toBeDefined();

    stubs.progress = lane({ identified: false, pendingBackfillSessions: 0 });
    rerender(bannerTree(arrivalFor(DataSyncLevelValue.Full)));

    expect(screen.queryByText(ANY_COUNTER)).toBeNull();
    expect(screen.queryByRole(PROGRESS_ROLE)).toBeNull();
    // And it must not claim completion either — `caughtUp` never arrived.
    expect(screen.queryByText(SYNCED_TITLE)).toBeNull();
  });

  it("never walks the counter backwards when new work arrives mid-sync", () => {
    // A high-water denominator fell over here: with a peak of 10 and 7 drained,
    // five arriving sessions pushed pending back to 8 and the counter dropped
    // from 7 / 10 to 2 / 10 with the bar retreating. The total absorbs the
    // arrivals instead — the work really did grow.
    stubs.progress = lane({ pendingBackfillSessions: 10 });
    const { rerender } = renderBanner(arrivalFor(DataSyncLevelValue.Full));

    stubs.progress = lane({ pendingBackfillSessions: 3 });
    // A FRESH element each time: React bails out of re-rendering when handed the
    // identical element reference, so a reused tree would silently never see the
    // new sample.
    rerender(bannerTree(arrivalFor(DataSyncLevelValue.Full)));
    expect(screen.getByText("7 / 10")).toBeDefined();

    stubs.progress = lane({ pendingBackfillSessions: 8 });
    rerender(bannerTree(arrivalFor(DataSyncLevelValue.Full)));

    expect(screen.getByText("7 / 15")).toBeDefined();
    expect(screen.queryByText("2 / 10")).toBeNull();
  });

  it("withholds the synced title while sessions were left undelivered", () => {
    // `caughtUp` goes true with sessions dead-lettered. "Sessions synced" over a
    // warning icon and a line saying two never made it is the card contradicting
    // itself in the same breath.
    stubs.progress = lane({ caughtUp: true, deadLetteredSessions: 2 });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.queryByText(SYNCED_TITLE)).toBeNull();
    expect(screen.getByText(UNDELIVERABLE)).toBeDefined();
  });

  it("withholds the synced title when the dead-letter count did not parse", () => {
    // Flooring a corrupt count to zero turned "we cannot read this" into "there
    // are none", and the success title then rested on it.
    stubs.progress = lane({
      caughtUp: true,
      deadLetteredSessions: Number.NaN,
    });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.queryByText(SYNCED_TITLE)).toBeNull();
    expect(screen.queryByText(NOT_A_NUMBER)).toBeNull();
  });

  it("counts both session queues, not just the backfill", () => {
    stubs.progress = lane({
      pendingBackfillSessions: 4,
      pendingIncrementalSessions: 6,
    });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.getByText("0 / 10")).toBeDefined();
  });

  it("shows no counter and no bar before the lane has measured anything", () => {
    // Not connected / older main process. A bar at 0 out of a made-up total is
    // the one thing this card must not do.
    stubs.progress = null;

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(
      screen.getByText(`Syncing your sessions to ${WORKSPACE}`)
    ).toBeDefined();
    expect(screen.queryByRole(PROGRESS_ROLE)).toBeNull();
    expect(screen.queryByText(ANY_COUNTER)).toBeNull();
  });

  it("ignores a lane that has not identified this device", () => {
    stubs.progress = lane({ identified: false, pendingBackfillSessions: 99 });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.queryByRole(PROGRESS_ROLE)).toBeNull();
    expect(screen.queryByText(UNIDENTIFIED_BACKLOG)).toBeNull();
  });

  it("discards a corrupt count instead of printing NaN", () => {
    stubs.progress = lane({
      pendingBackfillSessions: Number.NaN,
      pendingIncrementalSessions: -5,
    });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.queryByText(NOT_A_NUMBER)).toBeNull();
    expect(screen.queryByRole(PROGRESS_ROLE)).toBeNull();
  });

  it("stays honest for Off: no bar, no counter, no fabricated sync", () => {
    stubs.progress = lane({ pendingBackfillSessions: 10 });

    renderBanner(arrivalFor(DataSyncLevelValue.Off));

    expect(screen.getByText(SYNC_OFF_MESSAGE)).toBeDefined();
    expect(screen.queryByRole(PROGRESS_ROLE)).toBeNull();
    expect(screen.queryByText(ANY_COUNTER)).toBeNull();
    expect(screen.queryByText(SYNCING_TITLE)).toBeNull();
  });

  it("surfaces what could not be uploaded in the existing vocabulary", () => {
    stubs.progress = lane({
      deadLetteredSessions: 2,
      pendingBackfillSessions: 5,
    });

    renderBanner(arrivalFor(DataSyncLevelValue.Full));

    expect(screen.getByText(UNDELIVERABLE)).toBeDefined();
  });

  it("never leaves a hole where the workspace name goes", () => {
    // The prototype interpolates the workspace unconditionally, which would
    // render "Syncing your sessions to ".
    stubs.progress = lane({ pendingBackfillSessions: 1 });

    renderBanner(arrivalFor(DataSyncLevelValue.Full, null));

    expect(
      screen.getByText("Syncing your sessions to your workspace")
    ).toBeDefined();
  });
});
