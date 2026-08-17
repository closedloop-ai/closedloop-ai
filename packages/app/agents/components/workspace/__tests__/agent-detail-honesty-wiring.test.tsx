/**
 * ISS-5518 / ISS-5519 / ISS-5521 — the PRODUCTION wiring of the
 * `agents-detail-honesty` flag through `AgentDetail`.
 *
 * The helper-level suites (`detail-data-honesty.test.ts`,
 * `agent-slug-label.test.ts`) call `componentMetrics(detail, { honest: true })`
 * and `detailHeaderSubtitle({ honest: true, … })` directly, so they prove the
 * mappers behave — and nothing else. `AgentDetail` is the only production entry
 * point that reads the flag and hands it to those two mappers, and every one of
 * those call sites could be deleted with the rest of this change's tests green
 * (review-soul, class B — the helpers are tested, the caller is not).
 *
 * So this file mounts the real component through the real flag adapter. Three
 * named mutations must fail here:
 *   1. dropping `{ honest: honestDetail }` from the `componentMetrics` call;
 *   2. dropping `honest={honestDetail}` from `<DetailHeader>`;
 *   3. reading the flag under any key other than the shared one — `enabledFlags`
 *      resolves by exact key, so a typo'd key silently resolves false and the
 *      flag-ON expectations below stop holding.
 */
import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentDetail } from "../agent-detail";

const DIGEST =
  "c22ccd465ae7be300736a0ed014fbbc9a9721872ab6cf5cab5c1e5f72d5e26dd";
const HASH_SLUG = `subagent::${DIGEST}`;

type DetailBranchRow = AgentComponentDetail["branchesTab"][number];

/** A branch row exactly as `buildBranchesTab` emits it: no measurement on it. */
const unmeasuredBranch = {
  prState: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: null,
} as DetailBranchRow;

/**
 * The production shape all three tickets describe at once: a content-hash
 * subagent with NO definition path (so the subtitle falls to the identity key),
 * branch rows that measured nothing, and a merged-PR count the server took over
 * a capped sample.
 */
function honestyFixture(): AgentComponentDetail {
  return {
    ...EMPTY_COHORT_DELIVERY_METRICS,
    id: "uuid-detail-1",
    slug: HASH_SLUG,
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7247,
    locPerDollar: 9.03,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: { format: "md", path: "" },
    prompt: "Coordinate work efficiently.",
    versions: [],
    resolvedState: ComponentResolvedState.Unresolved,
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [unmeasuredBranch, unmeasuredBranch],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    mergedPrs: 996,
    mergedPrsTruncated: true,
  };
}

function detailSource(detail: AgentComponentDetail): AgentComponentsDataSource {
  return {
    scope: "test-honesty-wiring",
    list: () => Promise.reject(new Error("list unused in detail tests")),
    detail: () => Promise.resolve(detail),
  };
}

function Wrapper({
  children,
  flagOn,
}: {
  children: ReactNode;
  flagOn: boolean;
}) {
  return (
    <AppCoreStoryProviders
      enabledFlags={flagOn ? [AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY] : []}
    >
      <AgentComponentsDataSourceProvider
        dataSource={detailSource(honestyFixture())}
      >
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

const renderDetail = (flagOn: boolean) =>
  render(
    <Wrapper flagOn={flagOn}>
      <AgentDetail backHref="/agents" slug={HASH_SLUG} />
    </Wrapper>
  );

const RE_LINES_SHIPPED = /lines shipped/i;
const RE_TOTAL_COST = /total cost/i;
const RE_MERGED_PRS = /merged prs/i;

describe("AgentDetail honesty flag wiring", () => {
  describe("flag ON", () => {
    it("drops the two cards nothing measured (ISS-5519)", async () => {
      renderDetail(true);
      await screen.findByText(RE_MERGED_PRS);

      // Proves `componentMetrics` is actually CALLED with `{ honest }` — the
      // mapper test cannot, because it passes the option itself.
      expect(screen.queryByText(RE_LINES_SHIPPED)).toBeNull();
      expect(screen.queryByText(RE_TOTAL_COST)).toBeNull();
    });

    it("keeps the LOC/$ the server did compute (ISS-5519)", async () => {
      renderDetail(true);

      expect(await screen.findByText("9.03")).toBeInTheDocument();
    });

    it("never publishes the content-hash digest under the title (ISS-5518)", async () => {
      renderDetail(true);
      await screen.findByText(RE_MERGED_PRS);

      // Proves `honest` reaches `DetailHeader`. The fixture has no definition
      // path, so without it the subtitle prints all 64 hex characters.
      expect(screen.queryByText(DIGEST)).toBeNull();
    });
  });

  /**
   * ISS-6462: NOT under `flag ON`. The disclosure left this flag's scope, so a
   * case asserting it inside the gated block would pass with the flag wiring
   * deleted — one of the three mutations this file's docblock says must fail
   * here. It is asserted once, ungated, plus once more in the flag-OFF case
   * below, which is where its independence from the gate actually shows.
   */
  it("discloses the capped Merged PRs population regardless of the flag (ISS-5521)", async () => {
    renderDetail(true);

    expect(await screen.findByText("996+")).toBeInTheDocument();
  });

  describe("flag OFF", () => {
    /**
     * ISS-6462 (wongk, #5096 review): the Merged PRs DISCLOSURE left this flag's
     * scope, so the count reads `996+` here too. The Packs Performance tile
     * discloses the same cap off the same field with no gate, and a flag that
     * leaves one of two screens claiming coverage it does not have is not a
     * closed-by-default rollout — it is half a defect.
     *
     * The other two surfaces are unchanged and still pinned: the two unmeasured
     * cards and the content-hash digest are what the gate still owns.
     */
    it("keeps the two dashed cards and the digest, and still discloses the cap", async () => {
      renderDetail(false);

      expect(await screen.findByText(RE_LINES_SHIPPED)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByText(RE_TOTAL_COST)).toBeInTheDocument()
      );
      expect(screen.getByText("996+")).toBeInTheDocument();
      expect(screen.getByText(DIGEST)).toBeInTheDocument();
    });
  });
});
