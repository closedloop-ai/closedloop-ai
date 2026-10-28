import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { TOKEN_TREND_WINDOW_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetailWithPromote } from "../agent-detail-with-promote";

/**
 * ISS-9622 — the disclosure survives the APP BOUNDARY, not just the component.
 *
 * The sibling `token-trend-window-disclosure-wiring.test.tsx` mocks
 * `useAgentComponentTokenTrend`, so it proves the chart renders the sentence
 * when something hands it `appliedWindow` / `truncated` already shaped. Nothing
 * there notices if those fields never reach the chart: the real path runs
 * component → hook → `useApiClient` → the `ApiResult` envelope → the date
 * reviver, and every one of those layers can drop, rename, or retype a field
 * while the mocked-hook suite stays green. That is the same shape of gap
 * ISS-6887 already left once — the producer stated its bound and no client read
 * it — so this suite drives the REAL production mount site
 * (`AgentDetailWithPromote`, the only site `TokenTrendChart` mounts at) with the
 * hook UNMOCKED, against a canned wire body served over the injected transport.
 *
 * Measured, not asserted: reshaping the hook's `queryFn` to return only
 * `{slug, models, points}` — the shape a boundary that forgets the two honesty
 * fields would produce — turns two of the three cases here red and leaves the
 * mocked-hook suite fully green.
 */

const mockUseOrganization = vi.fn(() => ({
  membership: { role: "org:member" },
}));
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/skill::rtk-optimizer",
  useParams: () => ({ orgSlug: "org-test" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  // Token trend lives in Details; mount its real route rather than the default Artifact tab.
  useSearchParams: () => new URLSearchParams("tab=details"),
}));

const SLUG = "skill::rtk-optimizer";

const detail: AgentComponentDetail = {
  id: "uuid-1",
  slug: SLUG,
  name: "RTK Optimizer",
  kind: AgentComponentKind.Skill,
  sourceType: SourceType.Repo,
  source: "acme/repo",
  harness: Harness.Claude,
  invocations: 10,
  sessions: 3,
  locPerDollar: 2,
  trend: [1, 2],
  collaborators: [],
  computeTargetIds: ["t1"],
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-06-01T00:00:00.000Z",
  properties: { path: "/skills/rtk.md", format: "md" },
  prompt: "Optimize tokens.",
  versions: [],
  resolvedState: ComponentResolvedState.Unresolved,
  sessionsTab: [],
  sessionsTabTruncated: false,
  branchesTab: [],
  branchesTabTruncated: false,
  provenance: [],
  usageSessions: [],
  locDelta: null,
  successRate: null,
  successDelta: null,
  tokenEfficiencyDelta: null,
  efficiencyTrend: [],
  mergedPrs: null,
  qualityScore: null,
  qualityDelta: null,
};

// Only the detail read is stubbed: it is the page's scaffolding, not the
// boundary under test. `use-agent-component-token-trend` is deliberately NOT
// mocked — the whole point is that the real hook runs.
vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: () => ({
    data: detail,
    isLoading: false,
    isError: false,
  }),
}));

const RE_WINDOW = /last 90 days/i;
const RE_TRUNCATED = /most recent sessions only/i;
const RE_TOKEN_TREND_PATH = /\/token-trend$/;

/**
 * Exactly what `apps/api` serializes: `appliedWindow` bounds as ISO STRINGS and
 * `truncated` as a bare boolean, so the payload crosses `JSON.stringify` and the
 * client's reviver the same way the live response does.
 */
function tokenTrendBody(
  overrides: Partial<TokenTrendResponse> = {}
): TokenTrendResponse {
  return {
    slug: SLUG,
    models: ["claude-opus-4-5"],
    points: [
      {
        sessionId: "s1",
        sessionStartedAt: "2026-08-01T10:00:00.000Z",
        model: "claude-opus-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.1,
        runtimeMs: 1000,
        componentInvocations: 1,
        componentErrorCount: 0,
      },
    ],
    appliedWindow: {
      since: "2026-06-08T12:00:00.000Z",
      until: "2026-09-06T12:00:00.000Z",
    },
    truncated: true,
    ...overrides,
  };
}

const requestedPaths: string[] = [];

function tokenTrendRoute(body: TokenTrendResponse): FixtureRoute {
  return {
    method: "GET",
    path: "/agent-components/*",
    respond: ({ pathname }) => {
      requestedPaths.push(pathname);
      return body;
    },
  };
}

function renderRoute(body: TokenTrendResponse, flagOn: boolean) {
  return render(
    <AppCoreStoryProviders
      apiRoutes={[tokenTrendRoute(body)]}
      enabledFlags={
        flagOn ? [TOKEN_TREND_WINDOW_DISCLOSURE_FEATURE_FLAG_KEY] : []
      }
    >
      <AgentDetailWithPromote orgSlug="org-test" slug={SLUG} />
    </AppCoreStoryProviders>
  );
}

describe("ISS-9622: token-trend window disclosure across the app boundary", () => {
  beforeEach(() => {
    requestedPaths.length = 0;
  });

  it("renders the window and truncation the HTTP response actually carried", async () => {
    renderRoute(tokenTrendBody(), true);

    expect(await screen.findByText(RE_WINDOW)).toBeInTheDocument();
    expect(screen.getByText(RE_TRUNCATED)).toBeInTheDocument();
    // The disclosure came from a real request, not from cache-seeded state.
    expect(requestedPaths.some((p) => RE_TOKEN_TREND_PATH.test(p))).toBe(true);
  });

  it("states the window without claiming truncation when the response dropped nothing", async () => {
    renderRoute(tokenTrendBody({ truncated: undefined }), true);

    expect(await screen.findByText(RE_WINDOW)).toBeInTheDocument();
    expect(screen.queryByText(RE_TRUNCATED)).not.toBeInTheDocument();
  });

  it("stays silent while the gate is closed even though the response disclosed both", async () => {
    renderRoute(tokenTrendBody(), false);

    // Assert the request settled first: an absence assertion made before the
    // query resolves would pass for the wrong reason.
    await vi.waitFor(() =>
      expect(requestedPaths.some((p) => RE_TOKEN_TREND_PATH.test(p))).toBe(true)
    );
    expect(screen.queryByText(RE_WINDOW)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_TRUNCATED)).not.toBeInTheDocument();
  });
});
