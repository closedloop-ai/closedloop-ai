import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";
import { TeamScopeAuthorization } from "@/lib/team-scope-policy";
import type { AgentSessionCsvExportRow } from "../service/csv-export";
import { GET } from "./route";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  authorizeAgentSessionTeamScope: vi.fn(),
  findExportRows: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown } | undefined) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("../route-helpers", () => ({
  authorizeAgentSessionTeamScope: mocks.authorizeAgentSessionTeamScope,
}));

vi.mock("../service", () => ({
  agentSessionsService: { findExportRows: mocks.findExportRows },
}));

/**
 * Display names a spreadsheet would EXECUTE, or that would tear a record in
 * two. The route is the boundary that owes the escape — the same strings are
 * legitimate in the JSON list response and in the desktop store, and only the
 * downloaded file interprets them — so these assert the streamed BYTES rather
 * than the helper's return value (`csv-escape.test.ts` covers that).
 */
const FORMULA_TEAM_NAME = "\t=cmd|' /c calc'!A0";
const CR_BEARING_PROJECT_NAME = "Apollo\rInjected";

describe("GET /agent-sessions/export escaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.authorizeAgentSessionTeamScope.mockResolvedValue(
      TeamScopeAuthorization.Allowed
    );
  });

  it("neutralises a formula-triggering team name in the streamed file", async () => {
    mocks.findExportRows.mockResolvedValue({
      orgSlug: "acme",
      rows: [exportRow({ team: FORMULA_TEAM_NAME })],
    });

    const response = await callExport();

    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).not.toContain(`,${FORMULA_TEAM_NAME},`);
    expect(csv).toContain(`'${FORMULA_TEAM_NAME}`);
  });

  it("quotes a CR-bearing project name so it cannot open a second record", async () => {
    mocks.findExportRows.mockResolvedValue({
      orgSlug: "acme",
      rows: [exportRow({ project: CR_BEARING_PROJECT_NAME })],
    });

    const response = await callExport();

    expect(response.status).toBe(200);
    const csv = await response.text();
    // Bare, this CR is a record separator to Excel's classic-Mac line handling
    // and to several CSV parsers: the row splits and every later column lands
    // under the wrong header.
    expect(csv).not.toContain(`,${CR_BEARING_PROJECT_NAME},`);
    expect(csv).toContain(`"${CR_BEARING_PROJECT_NAME}"`);
  });
});

function exportRow(
  overrides: Partial<AgentSessionCsvExportRow>
): AgentSessionCsvExportRow {
  return {
    date: "2026-08-20",
    user: "Ada Lovelace",
    team: "Platform",
    project: "Apollo",
    harnessType: "claude-code",
    model: "opus",
    sessionCount: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCost: 1.5,
    ...overrides,
  };
}

function callExport(): Promise<Response> {
  return GET(
    createMockRequest({ url: "http://localhost:3002/agent-sessions/export" }),
    { params: Promise.resolve({}) } as never
  );
}
