/**
 * ISS-8972 / ISS-10816 — canonical Linked Sessions chips on the DESKTOP shell,
 * through the launched Electron app in authenticated cloud mode.
 *
 * The web sibling (`e2e/branches-linked-session-chips.spec.ts`) proves the web
 * route adapter; this proves the desktop one, where the canonical membership
 * summaries must survive the cloud IPC projection and the chip's UNPREFIXED
 * href must resolve through the Desktop route table (FEA-4051).
 * It also walks the flag chain — the seeded assignment travels
 * `seedDesktopFeatureFlags` → `getE2eSeededFeatureFlags` IPC →
 * `DesktopFeatureFlagProvider` → `useFeatureFlagEnabledOptional` before a chip
 * can render at all.
 *
 * CLOUD MODE IS NOT INCIDENTAL. The desktop's LOCAL SQLite branch read carries
 * no canonical membership summaries and deliberately keeps the count chip.
 * Chips are reachable from the cloud projection, so this spec stands up the
 * authenticated cloud server rather than seeding the local database.
 *
 * Three launches off one seeded session, because launches dominate this
 * suite's wall clock: the flag-OFF launch proves the count chip, and the two
 * flag-ON launches prove the canonical chip on each universal-status arm. The
 * unit suite
 * (`branches-linked-sessions-chips.test.tsx`) flips the gate on the shared
 * surface; only a launched app exercises the desktop chain.
 *
 * Prerequisite: `pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { UNKNOWN_ARTIFACT_STATUS_DISPLAY } from "@repo/api/src/types/artifact-status-display.ts";
import { ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY } from "@repo/api/src/types/artifact-status-label-honesty-flag.ts";
import {
  BranchParticipationKind,
  type BranchStatus,
} from "@repo/api/src/types/branch.ts";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.ts";
import { BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY } from "@repo/api/src/types/branches-linked-session-chips-flag.ts";
import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship.ts";
import { RELATED_SESSIONS_DISPLAY_CAP } from "@repo/api/src/types/related-session.ts";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status.ts";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag.ts";
import { BRANCH_STATUS_PARITY_SCENARIOS } from "../../../../e2e/helpers/branches-list-parity-data";
import {
  BASE_TIME,
  makeBranchRow,
  makeListResponse,
} from "../../../../e2e/helpers/branches-surface-fixtures";
import { canonicalBranchProjectionFixture } from "../../../../packages/app/branches/test-fixtures/canonical-branch-projection";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";

type ParityScenario = (typeof BRANCH_STATUS_PARITY_SCENARIOS)[number];

const LINKED_BRANCH = BRANCH_STATUS_PARITY_SCENARIOS[0];
const BRANCH_ID = LINKED_BRANCH.id;
/**
 * UUIDs: the batch route validates every id it is asked about as one. Keyed
 * by parity-scenario id so the corpus stays the shared record.
 */
const BRANCH_ARTIFACT_IDS: Record<ParityScenario["id"], string> = {
  [BRANCH_STATUS_PARITY_SCENARIOS[0].id]:
    "5c1c0a2e-6d1a-4f5b-9c3e-8a1d2f3b4c5d",
  [BRANCH_STATUS_PARITY_SCENARIOS[1].id]:
    "7d2e1b3f-8a4c-4d6e-9f0a-1b2c3d4e5f60",
  [BRANCH_STATUS_PARITY_SCENARIOS[2].id]:
    "9e3f2c4a-0b5d-4e7f-8a1b-2c3d4e5f6071",
};
const SESSION_ARTIFACT_ID = "session-9001";
const SESSION_SLUG = "SES-9001";
const SESSION_OWNER = "Avery Example";
const REVIEWED_SESSION_SLUG = "SES-REVIEWED-ONLY";
// The cloud projection describes at most 50 Wrote Sessions while retaining the
// complete population: 51 Wrote plus one unclassified legacy membership.
const DESCRIBED_WROTE_SESSION_COUNT = 50;
const QUALIFYING_SESSION_COUNT = 52;
const OVERFLOW_SESSION_COUNT = QUALIFYING_SESSION_COUNT - 1;
const CONTRIBUTED_LABEL =
  PROVENANCE_RELATIONSHIP_KIND_LABELS[ProvenanceRelationshipKind.Contribution];
const CHIP_ACCESSIBLE_NAME = new RegExp(
  `${SESSION_SLUG} · ${SESSION_OWNER} · Running · ${CONTRIBUTED_LABEL}`
);
const LEGACY_CHIP_ACCESSIBLE_NAME = new RegExp(
  `${SESSION_SLUG} · ${SESSION_OWNER} · Active · ${CONTRIBUTED_LABEL}`
);
const PROFILE_ID = "iss-8972-linked-session-chips-profile";
const AGENTS_SURFACE_HONESTY_FLAG_KEY = "agents-surface-honesty";
test("a desktop canonical Linked Session chip opens that Session detail on both status arms while the closed gate keeps the count", async () => {
  test.setTimeout(360_000);

  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8972-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8972-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8972-udd-"));
  const server = await startAuthenticatedBranchCloudServer({
    listFactory: branchListWithArtifactIds,
  });

  try {
    const launchBranches = ({
      chipsEnabled,
      sameProcessSessionSeed,
      universalStatus,
    }: {
      chipsEnabled: boolean;
      sameProcessSessionSeed?: ReturnType<
        typeof createAuthenticatedDesktopSessionRecord
      >;
      universalStatus: boolean;
    }) =>
      launchAuthenticatedDesktopApp({
        sameProcessSessionSeed,
        beforeLaunch: (launchUserDataDir) => {
          seedDesktopSettings(launchUserDataDir, {
            activeConfigId: PROFILE_ID,
            apiOrigin: server.origin,
            cloudConnectionEnabled: true,
            savedConfigs: [
              {
                apiOrigin: server.origin,
                gatewayId: AUTHENTICATED_GATEWAY_ID,
                id: PROFILE_ID,
                name: "ISS-8972 Linked Session Chips E2E",
                relayOrigin: "http://127.0.0.1:9",
                webAppOrigin: "http://127.0.0.1:3000",
              },
            ],
          });
          seedDesktopFeatureFlags(launchUserDataDir, {
            // The chips ship on the V2 surface; without it they render on nothing.
            [AGENTS_SURFACE_HONESTY_FLAG_KEY]: true,
            [ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY]: true,
            [BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY]: chipsEnabled,
            [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]: universalStatus,
          });
        },
        cloudReadReadiness: drainedCloudReadReadiness(),
        env: {
          CLAUDE_HOME: claudeHome,
          CL_AUTH_API_ORIGIN: server.origin,
          CODEX_HOME: codexHome,
        },
        userDataDir,
      });

    const closedGate = await launchBranches({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      chipsEnabled: false,
      universalStatus: true,
    });
    try {
      await expectAuthenticated(closedGate.page);
      await gotoNav(closedGate.page, "branches");

      // The gate closed by the seeded assignment: the count chip that shipped.
      await expect(
        closedGate.page.getByRole("link", {
          name: new RegExp(`${QUALIFYING_SESSION_COUNT} linked sessions`, "i"),
        })
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        closedGate.page.getByRole("link", { name: CHIP_ACCESSIBLE_NAME })
      ).toHaveCount(0);
      await expectZeroLinkedSessionsCell(closedGate.page);
    } finally {
      await closedGate.cleanup();
    }

    const legacyArm = await launchBranches({
      chipsEnabled: true,
      universalStatus: false,
    });
    try {
      await expectAuthenticated(legacyArm.page);
      await gotoNav(legacyArm.page, "branches");

      const legacyChip = legacyArm.page.getByRole("link", {
        name: LEGACY_CHIP_ACCESSIBLE_NAME,
      });
      await expect(legacyChip).toBeVisible({ timeout: 30_000 });
      await expectBranchStatusParity(legacyArm.page, false);
      await expectZeroLinkedSessionsCell(legacyArm.page);
      await expect(
        legacyArm.page.getByRole("link", { name: CHIP_ACCESSIBLE_NAME })
      ).toHaveCount(0);
    } finally {
      await legacyArm.cleanup();
    }

    const { page, cleanup } = await launchBranches({
      chipsEnabled: true,
      universalStatus: true,
    });

    try {
      await expectAuthenticated(page);

      await gotoNav(page, "branches");

      const chip = page.getByRole("link", { name: CHIP_ACCESSIBLE_NAME });
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await expectBranchStatusParity(page, true);
      await expectZeroLinkedSessionsCell(page);
      await expect(page.getByText(`+${OVERFLOW_SESSION_COUNT}`)).toBeVisible();
      const linkedSessionsCell = chip.locator(
        "xpath=ancestor::*[@role='gridcell'][1]"
      );
      const renderedDescriptions = await linkedSessionsCell
        .getByRole("link")
        .count();
      expect(renderedDescriptions).toBeGreaterThan(0);
      expect(renderedDescriptions).toBeLessThanOrEqual(
        RELATED_SESSIONS_DISPLAY_CAP
      );
      await expect(
        page.getByRole("link", { name: new RegExp(REVIEWED_SESSION_SLUG) })
      ).toHaveCount(0);

      await chip.click();

      // The desktop route table resolves the unprefixed path and the adapter
      // renders it hash-prefixed, so the Session's own ref is what must appear.
      await expect.poll(() => page.url()).toContain(SESSION_SLUG);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
  }
});

async function expectAuthenticated(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.desktopApi.getDesktopAuthState()))
    .toMatchObject({
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: AUTHENTICATED_USER_ID,
    });
}

function branchListWithArtifactIds() {
  return makeListResponse(
    BRANCH_STATUS_PARITY_SCENARIOS.map((scenario) =>
      makeBranchRow({
        artifactId: BRANCH_ARTIFACT_IDS[scenario.id],
        branchName: scenario.branchName,
        canonicalProjection: projectionForScenario(scenario),
        id: scenario.id,
        sessionIds: scenario.id === BRANCH_ID ? qualifyingSessionIds() : [],
        status: scenario.rawStatus as BranchStatus,
      })
    )
  );
}

function projectionForScenario(scenario: ParityScenario) {
  const common = canonicalBranchProjectionFixture.common;
  const isLinked = scenario.id === BRANCH_ID;
  const isReviewedOnly = scenario.id === BRANCH_STATUS_PARITY_SCENARIOS[1].id;
  const sessions = membershipSessions(isLinked, isReviewedOnly);
  return {
    ...canonicalBranchProjectionFixture,
    common: {
      ...common,
      identity: {
        ...common.identity,
        artifactId: BRANCH_ARTIFACT_IDS[scenario.id],
        branchName: scenario.branchName,
      },
      // The desktop view adapts with `preferCanonicalLastActive` too, so this
      // value is what the default 7-day window reads. The shared fixture's
      // pinned `observedAt` is weeks old and emptied the list before the chip
      // could render.
      lastActiveAt: {
        state: BranchMetricAvailability.Complete,
        value: BASE_TIME,
      },
      membership: {
        sessionIds: isLinked ? qualifyingSessionIds() : [],
        qualifyingSessionCount: isLinked ? QUALIFYING_SESSION_COUNT : 0,
        ...(sessions ? { sessions } : {}),
      },
    },
  };
}

async function expectBranchStatusParity(
  panel: Locator | Page,
  universalStatus: boolean
): Promise<void> {
  for (const scenario of BRANCH_STATUS_PARITY_SCENARIOS) {
    const row = panel
      .getByRole("link", { exact: true, name: scenario.branchName })
      .locator("xpath=ancestor::*[@role='row'][1]");
    const statusCell = row.locator('[data-column-id="status"]');
    await expect(
      statusCell.getByText(
        universalStatus ? scenario.universalLabel : scenario.legacyLabel,
        { exact: true }
      )
    ).toBeVisible({ timeout: 30_000 });
  }

  const nullRow = panel
    .getByRole("link", {
      exact: true,
      name: BRANCH_STATUS_PARITY_SCENARIOS[1].branchName,
    })
    .locator("xpath=ancestor::*[@role='row'][1]");
  const futureRow = panel
    .getByRole("link", {
      exact: true,
      name: BRANCH_STATUS_PARITY_SCENARIOS[2].branchName,
    })
    .locator("xpath=ancestor::*[@role='row'][1]");
  if (universalStatus) {
    await expect(
      futureRow.getByTitle(UNKNOWN_ARTIFACT_STATUS_DISPLAY.tooltip)
    ).toBeVisible();
    await expect(
      nullRow.getByTitle(UNKNOWN_ARTIFACT_STATUS_DISPLAY.tooltip)
    ).toHaveCount(0);
  }
}

async function expectZeroLinkedSessionsCell(
  panel: Locator | Page
): Promise<void> {
  const row = panel
    .getByRole("link", {
      exact: true,
      name: BRANCH_STATUS_PARITY_SCENARIOS[1].branchName,
    })
    .locator("xpath=ancestor::*[@role='row'][1]");
  const cell = row.locator('[data-column-id="sessions"]');

  await expect(cell.locator('[data-slot="grid-empty-value"]')).toHaveText("—");
  await expect(cell.getByRole("link")).toHaveCount(0);
}

function qualifyingSessionIds(): string[] {
  return Array.from({ length: QUALIFYING_SESSION_COUNT }, (_unused, index) =>
    qualifyingSessionId(index)
  );
}

function describedWroteSessions() {
  return Array.from(
    { length: DESCRIBED_WROTE_SESSION_COUNT },
    (_unused, index) => {
      const suffix = String(index + 1).padStart(4, "0");
      return {
        artifactId: qualifyingSessionId(index),
        displayedStatus: DISPLAYED_SESSION_STATUS.ACTIVE,
        lastInteractionAt: BASE_TIME,
        name:
          index === 0
            ? "Wire the Linked Sessions column"
            : `Qualifying Wrote Session ${suffix}`,
        navigableRef: index === 0 ? SESSION_SLUG : `SES-WROTE-${suffix}`,
        ownerName: SESSION_OWNER,
        participation: BranchParticipationKind.Wrote,
        rawStatus: SESSION_STATUS.ACTIVE,
        slug: index === 0 ? SESSION_SLUG : `SES-WROTE-${suffix}`,
      };
    }
  );
}

function reviewedOnlySession() {
  return {
    artifactId: "session-reviewed-only",
    displayedStatus: DISPLAYED_SESSION_STATUS.INACTIVE,
    lastInteractionAt: BASE_TIME,
    name: "Reviewed-only Session",
    navigableRef: REVIEWED_SESSION_SLUG,
    ownerName: SESSION_OWNER,
    participation: BranchParticipationKind.Reviewed,
    rawStatus: SESSION_STATUS.INACTIVE,
    slug: REVIEWED_SESSION_SLUG,
  };
}

function membershipSessions(isLinked: boolean, isReviewedOnly: boolean) {
  if (isLinked) {
    return describedWroteSessions();
  }
  if (isReviewedOnly) {
    return [reviewedOnlySession()];
  }
  return undefined;
}

function qualifyingSessionId(index: number): string {
  if (index === 0) {
    return SESSION_ARTIFACT_ID;
  }
  if (index === QUALIFYING_SESSION_COUNT - 1) {
    return "session-unclassified-legacy";
  }
  return `session-wrote-${String(index + 1).padStart(4, "0")}`;
}
