import type {
  HealthCheckResponse,
  McpProviderAvailability,
} from "@repo/api/src/types/compute-target";
import {
  CLAUDE_CLI_CHECK_ID,
  CODEX_CLI_CHECK_ID,
  deriveAvailableHarnesses,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { describe, expect, it, test } from "vitest";

function makeNeutralAvailability(available: boolean): McpProviderAvailability {
  return {
    available,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-06-09T00:00:00.000Z",
  };
}

function makeHealthCheck(
  mcpServers?: HealthCheckResponse["mcpServers"]
): HealthCheckResponse {
  return {
    checks: [],
    allRequiredPassed: true,
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

describe("deriveAvailableHarnesses", () => {
  const cases: {
    label: string;
    input: HealthCheckResponse;
    expected: HarnessType[];
  }[] = [
    {
      label: "both claude and codex available → returns both harnesses",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(true),
        codex: makeNeutralAvailability(true),
      }),
      expected: [HarnessType.Claude, HarnessType.Codex],
    },
    {
      label: "only claude available → returns claude only",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(true),
        codex: makeNeutralAvailability(false),
      }),
      expected: [HarnessType.Claude],
    },
    {
      label: "only codex available → returns codex only",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(false),
        codex: makeNeutralAvailability(true),
      }),
      expected: [HarnessType.Codex],
    },
    {
      label: "neither available → returns empty set",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(false),
        codex: makeNeutralAvailability(false),
      }),
      expected: [],
    },
    {
      label: "no mcpServers field → returns empty set",
      input: makeHealthCheck(),
      expected: [],
    },
    {
      label:
        "legacy closedloopAvailable=true for claude → includes claude harness",
      input: makeHealthCheck({
        claude: {
          closedloopAvailable: true,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
        codex: makeNeutralAvailability(false),
      }),
      expected: [HarnessType.Claude],
    },
    {
      label: "legacy closedloopAvailable=false for both → returns empty set",
      input: makeHealthCheck({
        claude: {
          closedloopAvailable: false,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
        codex: {
          closedloopAvailable: false,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
      }),
      expected: [],
    },
  ];

  test.each(cases)("$label", ({ input, expected }) => {
    expect(deriveAvailableHarnesses(input)).toEqual(expected);
  });
});

/**
 * ISS-5687. Mike's screenshot showed `Claude CLI 2.1.220 ✓`, `Codex CLI
 * 0.147.0 ✓`, both MCP rows "Not configured", and the picker rendering "No AI
 * harness available" — a claim the same payload disproves. The MCP server is an
 * OPTIONAL enhancement; the CLI is what runs the harness.
 */
describe("deriveAvailableHarnesses — optional MCP must not zero availability", () => {
  it("returns both harnesses when both CLIs pass and neither MCP is configured", () => {
    const input: HealthCheckResponse = {
      checks: [
        makePassingCliCheck(CLAUDE_CLI_CHECK_ID, "Claude CLI"),
        makePassingCliCheck(CODEX_CLI_CHECK_ID, "Codex CLI"),
      ],
      allRequiredPassed: true,
      mcpServers: {
        claude: makeNeutralAvailability(false),
        codex: makeNeutralAvailability(false),
      },
    };

    expect(deriveAvailableHarnesses(input)).toEqual([
      HarnessType.Claude,
      HarnessType.Codex,
    ]);
  });

  it("omits a harness whose CLI row is present but failing", () => {
    const input: HealthCheckResponse = {
      checks: [
        makePassingCliCheck(CLAUDE_CLI_CHECK_ID, "Claude CLI"),
        {
          id: CODEX_CLI_CHECK_ID,
          label: "Codex CLI",
          required: false,
          passed: false,
          error: "Not found",
        },
      ],
      allRequiredPassed: true,
    };

    expect(deriveAvailableHarnesses(input)).toEqual([HarnessType.Claude]);
  });

  /**
   * Conflicting signals in ONE snapshot: the CLI row says the harness cannot
   * launch, the MCP row says its server is connected. The CLI row is the direct
   * evidence and has to win — MCP availability is only a fallback for gateways
   * too old to emit these rows at all. Deriving the harness here would hand
   * auto-selection a target the very same payload proved unrunnable.
   */
  it("omits a harness whose CLI row failed even when its MCP server is available", () => {
    const input: HealthCheckResponse = {
      checks: [
        makePassingCliCheck(CLAUDE_CLI_CHECK_ID, "Claude CLI"),
        {
          id: CODEX_CLI_CHECK_ID,
          label: "Codex CLI",
          required: false,
          passed: false,
          error: "Not found",
        },
      ],
      allRequiredPassed: true,
      mcpServers: {
        claude: makeNeutralAvailability(false),
        // Contradicts the failing Codex CLI row above.
        codex: makeNeutralAvailability(true),
      },
    };

    expect(deriveAvailableHarnesses(input)).toEqual([HarnessType.Claude]);
  });

  it("omits a harness whose CLI row failed even when legacy closedloopAvailable is true", () => {
    const input: HealthCheckResponse = {
      checks: [
        {
          id: CLAUDE_CLI_CHECK_ID,
          label: "Claude CLI",
          required: false,
          passed: false,
          error: "Not found",
        },
      ],
      allRequiredPassed: true,
      mcpServers: {
        claude: {
          closedloopAvailable: true,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
      },
    };

    expect(deriveAvailableHarnesses(input)).toEqual([]);
  });

  it("still derives from mcpServers when a gateway emits no CLI rows", () => {
    const input: HealthCheckResponse = {
      checks: [],
      allRequiredPassed: true,
      mcpServers: { codex: makeNeutralAvailability(true) },
    };

    expect(deriveAvailableHarnesses(input)).toEqual([HarnessType.Codex]);
  });

  it("returns an empty set when a malformed payload carries no checks array", () => {
    const input = {
      allRequiredPassed: true,
    } as unknown as HealthCheckResponse;

    expect(deriveAvailableHarnesses(input)).toEqual([]);
  });
});

function makePassingCliCheck(id: string, label: string) {
  return { id, label, required: false, passed: true, version: "1.0.0" };
}
