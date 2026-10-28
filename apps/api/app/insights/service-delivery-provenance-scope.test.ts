/**
 * ISS-7404 regression guard — delivery provenance honors the `repo` scope floor.
 *
 * `getDelivery` resolves `githubProvenance` through
 * `resolveGitHubDataConnectionStatus`, which used to decide the user-OAuth
 * source from row presence and `revokedAt` alone. A Clerk grant carrying only
 * `read:user user:email` therefore captioned an EMPTY delivery dashboard as
 * `active` — every KPI on it is built from GitHub reads that credential is
 * denied. The floor now runs where the claim is made, not only where the read
 * is attempted.
 *
 * Lives beside `service.test.ts` rather than inside it because that file is on
 * the `noExcessiveLinesPerFile` grandfather list (shrink-only).
 */

import {
  InsightsGitHubProvenanceState,
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { withDb } from "@repo/database";
import {
  makeFakeDb,
  makeInsightsUserGrant,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { insightsService } from "./service";

const ORG_CTX = {
  organizationId: ORG,
  userId: "user-1",
  scope: InsightsScope.Org,
};
const NOW = new Date("2026-06-09T12:00:00.000Z");

async function deliveryProvenanceState(scopes: string[]) {
  const { db } = makeFakeDb({
    activeInstallation: null,
    counts: () => 0,
    userGrant: makeInsightsUserGrant({ scopes }),
  });
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );

  const result = await insightsService.getDelivery(
    ORG_CTX,
    InsightsPeriod.Quarter,
    NOW
  );
  return result.githubProvenance?.state;
}

describe("insightsService.getDelivery GitHub provenance scope floor", () => {
  it("reports a grant below the repo floor as disconnected", async () => {
    await expect(
      deliveryProvenanceState(["read:user", "user:email"])
    ).resolves.toBe(InsightsGitHubProvenanceState.Disconnected);
  });

  it("still reports a repo-scoped grant as active", async () => {
    await expect(deliveryProvenanceState([GITHUB_REPO_SCOPE])).resolves.toBe(
      InsightsGitHubProvenanceState.Active
    );
  });

  it("reports a grant with no scopes at all as disconnected", async () => {
    // No App-family carve-out here: the Clerk credential path rejects an empty
    // scope set outright, so such a grant can serve none of these KPIs.
    await expect(deliveryProvenanceState([])).resolves.toBe(
      InsightsGitHubProvenanceState.Disconnected
    );
  });
});
