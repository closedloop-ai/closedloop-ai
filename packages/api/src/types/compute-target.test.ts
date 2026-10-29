import { describe, expect, it } from "vitest";
import {
  DesktopCommandStatus,
  deriveAvailableHarnesses,
  HarnessType,
  type HealthCheckResponse,
  isComputeTargetOwnedByViewer,
  isMcpProviderAvailable,
  isTerminalStatus,
  parseSelectedHarness,
  toMintingApiOrigin,
} from "./compute-target.ts";

const baseHealthCheck: HealthCheckResponse = {
  checks: [],
  allRequiredPassed: true,
};

describe("compute target status helpers", () => {
  it.each([
    [DesktopCommandStatus.Done, true],
    [DesktopCommandStatus.Failed, true],
    [DesktopCommandStatus.Cancelled, true],
    [DesktopCommandStatus.Expired, true],
    [DesktopCommandStatus.Running, false],
  ])("classifies %s terminal=%s", (status, expected) => {
    expect(isTerminalStatus(status)).toBe(expected);
  });
});

describe("MCP provider availability helpers", () => {
  it("supports both neutral and legacy provider availability shapes", () => {
    expect(
      isMcpProviderAvailable({
        available: true,
        serverName: "closedloop",
        matchedUrl: "http://localhost:3010",
        checkedAt: "2026-08-08T00:00:00.000Z",
      })
    ).toBe(true);
    expect(
      isMcpProviderAvailable({
        closedloopAvailable: false,
        checkedAt: "2026-08-08T00:00:00.000Z",
      })
    ).toBe(false);
  });

  it("returns no harnesses when provider results are absent", () => {
    expect(deriveAvailableHarnesses(baseHealthCheck)).toEqual([]);
  });

  it("returns each available harness across neutral and legacy results", () => {
    expect(
      deriveAvailableHarnesses({
        ...baseHealthCheck,
        mcpServers: {
          claude: {
            closedloopAvailable: true,
            checkedAt: "2026-08-08T00:00:00.000Z",
          },
          codex: {
            available: true,
            serverName: "closedloop",
            matchedUrl: "http://localhost:3010",
            checkedAt: "2026-08-08T00:00:00.000Z",
          },
        },
      })
    ).toEqual([HarnessType.Claude, HarnessType.Codex]);
  });

  it("omits providers whose probes report unavailable", () => {
    expect(
      deriveAvailableHarnesses({
        ...baseHealthCheck,
        mcpServers: {
          claude: {
            available: false,
            serverName: null,
            matchedUrl: null,
            checkedAt: "2026-08-08T00:00:00.000Z",
          },
          codex: {
            closedloopAvailable: false,
            checkedAt: "2026-08-08T00:00:00.000Z",
          },
        },
      })
    ).toEqual([]);
  });
});

describe("toMintingApiOrigin", () => {
  it("reduces a configured URL to the bare origin both transports state", () => {
    expect(toMintingApiOrigin("https://api.origin-a.test/some/base/")).toBe(
      "https://api.origin-a.test"
    );
  });

  it.each([undefined, "", "api.origin-a.test"])(
    "states nothing for %j, so the sender omits the field",
    (value) => {
      expect(toMintingApiOrigin(value)).toBeUndefined();
    }
  );
});

describe("isComputeTargetOwnedByViewer", () => {
  it("treats an absent ownerName as viewer-owned", () => {
    expect(isComputeTargetOwnedByViewer({})).toBe(true);
  });

  it("treats a populated ownerName as not viewer-owned", () => {
    expect(isComputeTargetOwnedByViewer({ ownerName: "Someone Else" })).toBe(
      false
    );
  });
});

describe("parseSelectedHarness", () => {
  it.each([HarnessType.Claude, HarnessType.Codex])(
    "passes a recognized harness value %s through unchanged",
    (value) => {
      expect(parseSelectedHarness(value)).toBe(value);
    }
  );

  it.each([null, undefined, "", "future_harness"])(
    "defaults %j to Claude, since the column is free-text and can carry an unlaunchable value",
    (value) => {
      expect(parseSelectedHarness(value)).toBe(HarnessType.Claude);
    }
  );
});
