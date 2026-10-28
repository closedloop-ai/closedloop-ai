import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { useSessionCaller } from "@/__tests__/support/lib/session-caller.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import {
  EXPERIENCE_VARIANT,
  transitionCommand,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
// The snapshot read fans out to Clerk and PostHog; these cases are about the
// write and its receipt, so the acknowledgement's snapshot is a fixed object.
vi.mock("@/app/onboarding/guided/snapshot-service", () => ({
  guidedOnboardingSnapshotService: {
    getSnapshot: async () => ({ revision: 1 }),
  },
}));

import { PUT as completeWizard } from "@/app/onboarding/complete-wizard/route";
import { PUT as dismissChecklist } from "@/app/onboarding/dismiss-checklist/route";
import { POST as transition } from "@/app/onboarding/guided/transition/route";
import { ONBOARDING_SETTINGS_KEY } from "@/app/onboarding/service";

const harness = createReceiptRouteHarness();
const COMPLETE_WIZARD_ROUTE = "/onboarding/complete-wizard";
const TRANSITION_ROUTE = "/onboarding/guided/transition";
const NO_PARAMS = receiptRouteParams({});

/**
 * ISS-12552: an API-key onboarding write records a settings
 * receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 onboarding receipts", () => {
  afterEach(() => harness.cleanup());

  it("complete-wizard rolls the marker back when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    const response = await completeWizard(
      apiKeyRouteRequest("PUT", COMPLETE_WIZARD_ROUTE, {}),
      NO_PARAMS
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await readOnboardingSettings(world.organizationId)).toBeUndefined();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("dismiss-checklist keeps the checklist when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    const response = await dismissChecklist(
      apiKeyRouteRequest("PUT", "/onboarding/dismiss-checklist"),
      NO_PARAMS
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await readChecklistDismissedAt(world.userId)).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("a first transition creates no run when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    const response = await transition(
      apiKeyRouteRequest(
        "POST",
        TRANSITION_ROUTE,
        transitionCommand({ revision: 0 })
      ),
      NO_PARAMS
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await readAttemptRevision(world)).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("a later transition leaves the run unmoved when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    await seedAttempt(world);
    failReceiptInserts();

    const response = await transition(
      apiKeyRouteRequest(
        "POST",
        TRANSITION_ROUTE,
        transitionCommand({ revision: 1 })
      ),
      NO_PARAMS
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await readAttemptRevision(world)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("records a settings write for complete-wizard", async () => {
    const world = await harness.seedWorld();

    const response = await completeWizard(
      apiKeyRouteRequest("PUT", COMPLETE_WIZARD_ROUTE, {}),
      NO_PARAMS
    );

    expect(response.status).toBe(200);
    expect(await readReceipts(world.organizationId)).toEqual([
      settingsReceipt(OperationReceiptOutcome.Committed, COMPLETE_WIZARD_ROUTE),
    ]);
  });

  it("records a transition, and its redelivery as a no-op", async () => {
    const world = await harness.seedWorld();
    const command = transitionCommand({ revision: 0 });
    const post = () =>
      transition(
        apiKeyRouteRequest("POST", TRANSITION_ROUTE, command),
        NO_PARAMS
      );

    const statuses = [(await post()).status, (await post()).status];

    expect(statuses).toEqual([200, 200]);
    expect(await readAttemptRevision(world)).toBe(1);
    expect(await readReceipts(world.organizationId)).toEqual(
      [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
        (outcome) => settingsReceipt(outcome, TRANSITION_ROUTE)
      )
    );
  });

  it("writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    turnAttributionFlagOff();

    const response = await dismissChecklist(
      apiKeyRouteRequest("PUT", "/onboarding/dismiss-checklist"),
      NO_PARAMS
    );

    expect(response.status).toBe(200);
    expect(await readChecklistDismissedAt(world.userId)).not.toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

/**
 * ISS-12552: flag-off behavior equals main for onboarding writes. With
 * `attribution-evidence-policy` off, or for a session caller, each write runs
 * as it does on main, with no transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 onboarding writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("dismiss-checklist dismisses outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await dismissChecklist(
        apiKeyRouteRequest("PUT", "/onboarding/dismiss-checklist"),
        NO_PARAMS
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect(await readChecklistDismissedAt(world.userId)).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("dismiss-checklist dismisses outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      useSessionCaller();
      const transactions = countTransactions();

      const response = await dismissChecklist(
        apiKeyRouteRequest("PUT", "/onboarding/dismiss-checklist"),
        NO_PARAMS
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await readChecklistDismissedAt(world.userId)).not.toBeNull();
    });

    it("a first transition creates the run outside any transaction", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await transition(
        apiKeyRouteRequest(
          "POST",
          TRANSITION_ROUTE,
          transitionCommand({ revision: 0 })
        ),
        NO_PARAMS
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ revision: 1 });
      expect(transactions.opened).toBe(0);
      expect(await readAttemptRevision(world)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a later transition moves the run outside any transaction", async () => {
      const world = await harness.seedWorld();
      await seedAttempt(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await transition(
        apiKeyRouteRequest(
          "POST",
          TRANSITION_ROUTE,
          transitionCommand({ revision: 1 })
        ),
        NO_PARAMS
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await readAttemptRevision(world)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

type World = { organizationId: string; userId: string };

function settingsReceipt(
  outcome: OperationReceiptOutcome,
  route: string
): Record<string, unknown> {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route,
  };
}

async function readOnboardingSettings(
  organizationId: string
): Promise<unknown> {
  const organization = await withDb((db) =>
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  const settings = organization.settings as Record<string, unknown> | null;
  return settings?.[ONBOARDING_SETTINGS_KEY];
}

async function readChecklistDismissedAt(userId: string): Promise<Date | null> {
  const user = await withDb((db) =>
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { onboardingChecklistDismissedAt: true },
    })
  );
  return user.onboardingChecklistDismissedAt;
}

async function readAttemptRevision(world: World): Promise<number | null> {
  const attempt = await withDb((db) =>
    db.onboardingAttempt.findFirst({
      where: { organizationId: world.organizationId, userId: world.userId },
      select: { revision: true },
    })
  );
  return attempt?.revision ?? null;
}

async function seedAttempt(world: World): Promise<void> {
  const { host, state } = transitionCommand();
  await withDb((db) =>
    db.onboardingAttempt.create({
      data: {
        organizationId: world.organizationId,
        userId: world.userId,
        experienceVariant: EXPERIENCE_VARIANT,
        host,
        state,
        revision: 1,
      },
      select: { id: true },
    })
  );
}
