// ISS-11284 branch coverage for connection-status-section.tsx:
// describeCloudConnectionStatus's Online/Disabled(cloudStatus)/Unknown branches
// and formatConnectionSecurityValue's detail/mode-fallback branches. Each test
// picks a gatewayHealthy/serverAlive combo that renders "Offline" for the
// Gateway cell so its label never collides with the Cloud Connection cell's
// text under assertion.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CloudSyncBacklog } from "../../../../shared/cloud-read-readiness-contract";
import { resolveCloudSyncBacklog } from "../../../../shared/cloud-read-readiness-contract";
import { ConnectionSecurityMode } from "../../../../shared/connection-security";
import type { CloudStatus } from "../../../hooks/use-cloud-status";
import { CloudStatusKind } from "../../../hooks/use-cloud-status";
import { ConnectionStatusSection } from "../connection-status-section";

/** Before the burn-down's first sample — a neutral filler, not under test here. */
const UNKNOWN_BACKLOG: CloudSyncBacklog = resolveCloudSyncBacklog(null);

function cellValue(label: string): string | null {
  const labelEl = screen.getByText(label);
  return labelEl.nextElementSibling?.textContent ?? null;
}

function renderSection(props: {
  cloudStatus: CloudStatus | null;
  security?: unknown;
}): void {
  render(
    <ConnectionStatusSection
      cloudConnectionEnabled={true}
      cloudStatus={props.cloudStatus}
      cloudSyncBacklog={UNKNOWN_BACKLOG}
      cloudSyncProgress={null}
      // Neither `serverAlive === false` nor `gatewayHealthy === true/false`:
      // falls through to the default Offline bucket, so "Gateway" never says
      // the same word as the Cloud Connection cell under test.
      gatewayHealthy={undefined}
      gatewayPort={undefined}
      remoteCommandsPaused={false}
      security={props.security}
      serverAlive={true}
    />
  );
}

describe("ConnectionStatusSection — cloud connection status branches", () => {
  it("reports Connected when the cloud socket kind is online", () => {
    renderSection({ cloudStatus: { kind: CloudStatusKind.Online } });
    expect(cellValue("Cloud Connection")).toBe("Connected");
  });

  it("reports Disabled with the reported reason when the cloud status kind is disabled", () => {
    renderSection({
      cloudStatus: { kind: CloudStatusKind.Disabled, reason: "opted out" },
    });
    expect(cellValue("Cloud Connection")).toBe("Disabled");
    expect(
      screen
        .getByText("Cloud Connection")
        .nextElementSibling?.getAttribute("title")
    ).toBe("opted out");
  });

  it("reports Connection failed with the error as both detail and visible reason when degraded", () => {
    renderSection({
      cloudStatus: { kind: CloudStatusKind.Degraded, error: "socket reset" },
    });
    expect(cellValue("Cloud Connection")).toBe("Connection failed");
    expect(screen.getByText("socket reset")).not.toBeNull();
  });

  it("reports Unknown for an unrecognized cloud status kind", () => {
    renderSection({ cloudStatus: { kind: CloudStatusKind.Unknown } });
    expect(cellValue("Cloud Connection")).toBe("Unknown");
  });
});

describe("ConnectionStatusSection — connection security formatting branches", () => {
  it("prefers the human-readable detail when present", () => {
    renderSection({
      cloudStatus: null,
      security: {
        detail: "Enhanced — requests are signed",
        mode: ConnectionSecurityMode.Enhanced,
      },
    });
    expect(cellValue("Security")).toBe("Enhanced — requests are signed");
  });

  it("falls back to the machine mode with underscores opened up when detail is absent", () => {
    renderSection({
      cloudStatus: null,
      security: { mode: ConnectionSecurityMode.SigningUnavailable },
    });
    expect(cellValue("Security")).toBe("signing unavailable");
  });

  it("falls back to the placeholder when neither detail nor mode is present", () => {
    renderSection({ cloudStatus: null, security: {} });
    expect(cellValue("Security")).toBe("...");
  });

  it("falls back to the placeholder when the security value fails schema validation", () => {
    renderSection({ cloudStatus: null, security: "enhanced" });
    expect(cellValue("Security")).toBe("...");
  });
});
