import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CloudSyncStateBadge } from "../cloud-sync-state-badge";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const STILL_UPLOADING = /still uploading to the cloud/i;
const IN_THE_CLOUD = /this session is in the cloud/i;
const LOCAL_ONLY_PREFIX = /^\s*Local only:/i;
const LAST_UPLOAD_FAILED = /last transcript upload failed/i;
const SYNCS_AUTOMATICALLY = /syncs automatically/i;

describe("CloudSyncStateBadge (PRD-536 E6, #3449)", () => {
  it("renders a state-carrying visible label on a pending row", () => {
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
      />
    );

    const badge = screen.getByTestId("cloud-sync-state-badge");
    // Visible label states the state, not a bare "Local".
    expect(badge).toHaveTextContent("Local only");
    expect(badge).toHaveAttribute(
      "data-cloud-sync-state",
      AgentSessionCloudSyncState.Pending
    );
  });

  it("uses a plain-comma aria-label (customer-facing SR text, no em dash)", () => {
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
      />
    );

    const badge = screen.getByTestId("cloud-sync-state-badge");
    expect(badge).toHaveAttribute(
      "aria-label",
      "Local only, not yet synced to cloud."
    );
    expect(badge.getAttribute("aria-label")).not.toContain("—");
  });

  it("carries a hover tooltip explaining the session is still uploading, without repeating the label word (#4150)", () => {
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
      />
    );

    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip).toHaveTextContent(STILL_UPLOADING);
    // The hover starts where the label ran out — it no longer opens with a
    // "Local only:" prefix that repeats the chip word for word.
    expect(tooltip.textContent).not.toMatch(LOCAL_ONLY_PREFIX);
  });

  it("does NOT overload the provenance read-source badge testid", () => {
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
      />
    );

    // A support query auditing provenance by `read-source-badge` must not scoop
    // up this sync chip.
    expect(screen.queryByTestId("read-source-badge")).not.toBeInTheDocument();
  });

  it("renders nothing for a synced row (no wall of redundant chips)", () => {
    render(
      <CloudSyncStateBadge cloudSyncState={AgentSessionCloudSyncState.Synced} />
    );

    expect(
      screen.queryByTestId("cloud-sync-state-badge")
    ).not.toBeInTheDocument();
  });

  it("renders nothing for an absent (version-skewed) sync state", () => {
    render(<CloudSyncStateBadge cloudSyncState={undefined} />);

    expect(
      screen.queryByTestId("cloud-sync-state-badge")
    ).not.toBeInTheDocument();
  });
});

describe("CloudSyncStateBadge transcript-scoped copy (ISS-4647)", () => {
  it("names the transcript as still syncing when the blob is in flight (#4150 — matches the detail panel)", () => {
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
        transcriptDisposition={TranscriptDisposition.Syncing}
      />
    );

    const badge = screen.getByTestId("cloud-sync-state-badge");
    // Matches session-transcript-panel.tsx's "Transcript still syncing" title.
    expect(badge).toHaveTextContent("Transcript still syncing");
    // "Local only" would be a lie here — the row was served FROM the cloud.
    expect(badge).not.toHaveTextContent("Local only");
    expect(badge.getAttribute("aria-label")).toContain(
      "Transcript still syncing"
    );
    expect(badge.getAttribute("aria-label")).not.toContain("—");
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(
      IN_THE_CLOUD
    );
  });

  it("admits the failure (not 'syncs automatically') when the last transcript upload failed (#4150 — no list/detail contradiction)", () => {
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
        transcriptDisposition={TranscriptDisposition.FailedTransient}
      />
    );

    const badge = screen.getByTestId("cloud-sync-state-badge");
    // The detail panel shows "Transcript upload failed" with a Retry; the list
    // must not tell the user "syncs automatically" and contradict it.
    expect(badge).toHaveTextContent("Transcript sync failed");
    expect(badge).not.toHaveTextContent("Local only");
    expect(badge.getAttribute("aria-label")).toContain("failed");
    expect(badge.getAttribute("aria-label")).not.toContain("—");
    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip).toHaveTextContent(IN_THE_CLOUD);
    expect(tooltip).toHaveTextContent(LAST_UPLOAD_FAILED);
    expect(tooltip).not.toHaveTextContent(SYNCS_AUTOMATICALLY);
  });

  it.each([
    TranscriptDisposition.Synced,
    TranscriptDisposition.Stale,
    TranscriptDisposition.FailedPermanent,
    TranscriptDisposition.NeverExpected,
  ])("keeps the Local only copy when the transcript is settled (%s)", (transcriptDisposition) => {
    // A settled transcript cannot be the reason this row is pending, so the gap
    // is the session itself — the broader statement is the honest one.
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
        transcriptDisposition={transcriptDisposition}
      />
    );

    expect(screen.getByTestId("cloud-sync-state-badge")).toHaveTextContent(
      "Local only"
    );
  });

  it("keeps the Local only copy when no transcript verdict was published", () => {
    // The desktop-outbox case, and any version-skewed producer that omits the
    // field: an unknown gap must not be narrowed to "just the transcript".
    render(
      <CloudSyncStateBadge
        cloudSyncState={AgentSessionCloudSyncState.Pending}
      />
    );

    expect(screen.getByTestId("cloud-sync-state-badge")).toHaveTextContent(
      "Local only"
    );
  });
});
