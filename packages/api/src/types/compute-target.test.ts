import { describe, expect, it } from "vitest";
import {
  DesktopCommandStatus,
  deriveAvailableHarnesses,
  HarnessType,
  type HealthCheckResponse,
  isMcpProviderAvailable,
  isTerminalStatus,
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
