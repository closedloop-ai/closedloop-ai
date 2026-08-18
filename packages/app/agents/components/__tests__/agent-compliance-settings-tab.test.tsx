import type { ComplianceItem } from "@repo/api/src/types/analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentComplianceSettingsTab } from "../agent-compliance-settings-tab";

// Mock the data hook so the panel can be exercised in isolation.
const mockUseCompliance = vi.fn();
vi.mock("@repo/app/agents/hooks/use-agent-component-compliance", () => ({
  useAgentComponentCompliance: () => mockUseCompliance(),
}));

const RE_EMPTY = /no compliance gaps/i;
const RE_ERROR = /failed to load compliance data/i;
const RE_REGION = /distribution compliance/i;
const RE_TRUNCATION_NOTE = /first 1 of 12/i;
const RE_ANY_TRUNCATION_NOTE = /of \d+ distributions/i;

const items: ComplianceItem[] = [
  {
    distributionId: "dist-1",
    catalogItemName: "rtk",
    kind: "mcp",
    mode: "auto_install",
    notInstalledCount: 3,
    installedButUnusedCount: 1,
    totalTargetCount: 5,
  },
];

describe("AgentComplianceSettingsTab", () => {
  it("renders compliance rows when the hook returns items", () => {
    mockUseCompliance.mockReturnValue({
      data: { items, total: items.length },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.getAllByText("rtk").length).toBeGreaterThan(0);
    expect(screen.queryByText(RE_EMPTY)).not.toBeInTheDocument();
  });

  it("renders the properly-cased kind label (MCP, not Mcp)", () => {
    mockUseCompliance.mockReturnValue({
      data: { items, total: items.length },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.queryByText("Mcp")).not.toBeInTheDocument();
  });

  it("shows a truncation note when the server capped the gap list", () => {
    mockUseCompliance.mockReturnValue({
      data: { items, total: 12, truncated: true },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.getByText(RE_TRUNCATION_NOTE)).toBeInTheDocument();
  });

  it("omits the truncation note when the full gap list fits", () => {
    mockUseCompliance.mockReturnValue({
      data: { items, total: items.length, truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.queryByText(RE_ANY_TRUNCATION_NOTE)).not.toBeInTheDocument();
  });

  it("renders the empty state when there are no gaps", () => {
    mockUseCompliance.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.getByText(RE_EMPTY)).toBeInTheDocument();
  });

  it("renders the error state when the hook errors", () => {
    mockUseCompliance.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.getByText(RE_ERROR)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("preserves the accessible region name", () => {
    mockUseCompliance.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<AgentComplianceSettingsTab />);

    expect(screen.getByRole("region", { name: RE_REGION })).toBeInTheDocument();
  });
});
